import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { buildServer } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/config.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { RunRepository } from "../../src/server/db/repositories/run.repository.js";
import { SSEHub } from "../../src/server/sse/sse-hub.js";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";

type DraftView = {
  content: string;
  revision: number;
};

type QueueItemView = {
  id: string;
  state: string;
  content: string | null;
  revision: number;
  local_run_id: string | null;
};

type QueueView = {
  data: QueueItemView[];
};

type RunView = {
  id: string;
  hermes_run_id: string | null;
  local_state: string;
  upstream_status: string | null;
  approval: { request_id: string; choices: string[] } | null;
};

async function waitFor<T>(
  check: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("Phase 4: Queue and runs HTTP integration", () => {
  let app: FastifyInstance | null = null;
  let db: Database.Database | null = null;
  let fakeHermes: FakeHermesServer;
  let config: AppConfig;

  beforeEach(async () => {
    fakeHermes = new FakeHermesServer();
    const hermesBaseUrl = await fakeHermes.start();
    db = new Database(":memory:");
    runMigrations(db);

    config = {
      host: "127.0.0.1",
      port: 0,
      dataDir: "/tmp/emu-chat-test",
      sqliteDbPath: ":memory:",
      hermesBaseUrl,
      hermesApiKey: "test-token",
      logLevel: "error",
      isProduction: false,
    };
    app = buildServer(config, { db });
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
    app = null;
    if (db?.open) db.close();
    db = null;
    await fakeHermes.close();
  });

  async function createMappedConversation(): Promise<string> {
    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/conversations",
      payload: { title: "Queue test" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { conversation_id: string };
    return body.conversation_id;
  }

  async function putDraft(
    conversationId: string,
    content: string,
    expectedRevision: number,
  ): Promise<DraftView> {
    const response = await app!.inject({
      method: "PUT",
      url: `/api/v1/conversations/${conversationId}/draft`,
      payload: { content, expected_revision: expectedRevision },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as DraftView;
  }

  it("atomically moves a draft into the queue and replays the same request", async () => {
    const conversationId = await createMappedConversation();
    const initialDraft = await putDraft(
      conversationId,
      "Draft sent through the queue",
      0,
    );
    expect(initialDraft).toMatchObject({
      content: "Draft sent through the queue",
      revision: 1,
    });

    // A paused conversation must still accept sends but must leave them queued.
    db!
      .prepare(
        "UPDATE conversations SET queue_paused = 1, pause_reason = 'manual_resume_required' WHERE id = ?",
      )
      .run(conversationId);

    const clientRequestId = "00000000-0000-4000-8000-000000000401";
    const submission = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: clientRequestId,
        expected_draft_revision: 1,
      },
    });
    expect(submission.statusCode).toBe(202);
    const sent = submission.json() as {
      object: string;
      replayed: boolean;
      queue_item: QueueItemView;
      draft: DraftView;
    };
    expect(sent).toMatchObject({
      object: "emu_chat.message_submission",
      replayed: false,
      queue_item: {
        state: "queued",
        content: "Draft sent through the queue",
        revision: 0,
      },
      draft: { content: "", revision: 2 },
    });

    const replay = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: clientRequestId,
        expected_draft_revision: 999,
      },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({
      replayed: true,
      queue_item: { id: sent.queue_item.id, state: "queued" },
      draft: { content: "", revision: 2 },
    });

    const queue = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/queue`,
    });
    expect(queue.json()).toMatchObject({
      paused: true,
      data: [{ id: sent.queue_item.id, state: "queued" }],
    });
  });

  it("rolls back dispatch when Run insertion fails and can dispatch the same item later", async () => {
    const conversationId = await createMappedConversation();
    db!
      .prepare(
        "UPDATE conversations SET queue_paused = 1, pause_reason = 'manual_resume_required' WHERE id = ?",
      )
      .run(conversationId);
    await putDraft(conversationId, "Dispatch after rollback", 0);
    const sent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000409",
        expected_draft_revision: 1,
      },
    });
    const itemId = (sent.json() as { queue_item: QueueItemView }).queue_item.id;
    const insert = vi
      .spyOn(RunRepository.prototype, "insert")
      .mockImplementationOnce(() => {
        throw new Error("injected Run insert failure");
      });

    const resumed = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/queue/resume`,
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    await waitFor(() => (insert.mock.calls.length === 1 ? true : undefined));
    expect(
      db!.prepare("SELECT state FROM queue_items WHERE id = ?").get(itemId),
    ).toMatchObject({ state: "queued" });
    expect(new RunRepository(db!).findByQueueItemId(itemId)).toBeNull();

    await waitFor(
      () =>
        new RunRepository(db!).findByQueueItemId(itemId)?.local_state ===
        "reconciled"
          ? true
          : undefined,
      5_000,
    );
    const sessionId = (
      db!
        .prepare("SELECT hermes_session_id FROM conversations WHERE id = ?")
        .get(conversationId) as { hermes_session_id: string }
    ).hermes_session_id;
    expect(
      fakeHermes
        .getMessages(sessionId)
        ?.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("recovers a lost admission response after restart using the original Hermes run", async () => {
    const conversationId = await createMappedConversation();
    fakeHermes.loseNextRunAdmissionResponse = true;
    await putDraft(conversationId, "Recover original Hermes run", 0);
    const sent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000410",
        expected_draft_revision: 1,
      },
    });
    expect(sent.statusCode).toBe(202);
    const itemId = (sent.json() as { queue_item: QueueItemView }).queue_item.id;
    await waitFor(() => {
      const item = db!
        .prepare("SELECT state, last_error_code FROM queue_items WHERE id = ?")
        .get(itemId) as { state: string; last_error_code: string | null };
      return item.state === "dispatching" && item.last_error_code
        ? true
        : undefined;
    });

    await app!.close();
    app = null;
    db!
      .prepare("UPDATE queue_items SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), itemId);
    app = buildServer(config, { db: db! });
    await app.ready();
    await waitFor(() => {
      const item = db!
        .prepare("SELECT state FROM queue_items WHERE id = ?")
        .get(itemId) as { state: string };
      return item.state === "done" ? true : undefined;
    });
    const item = db!
      .prepare("SELECT attempt_count FROM queue_items WHERE id = ?")
      .get(itemId) as { attempt_count: number };
    expect(item.attempt_count).toBe(2);
    expect(fakeHermes.admissionRequests).toBe(2);
    const sessionId = (
      db!
        .prepare("SELECT hermes_session_id FROM conversations WHERE id = ?")
        .get(conversationId) as { hermes_session_id: string }
    ).hermes_session_id;
    expect(
      fakeHermes
        .getMessages(sessionId)
        ?.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("stops after four unconfirmed admissions and frees the global slot", async () => {
    const uncertainConversationId = await createMappedConversation();
    const nextConversationId = await createMappedConversation();
    fakeHermes.failRunAdmissions = 4;
    await putDraft(uncertainConversationId, "Unconfirmed submission", 0);
    const sent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${uncertainConversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000411",
        expected_draft_revision: 1,
      },
    });
    const itemId = (sent.json() as { queue_item: QueueItemView }).queue_item.id;

    for (let attempt = 1; attempt < 4; attempt += 1) {
      await waitFor(() => {
        const row = db!
          .prepare(
            "SELECT attempt_count, last_error_code FROM queue_items WHERE id = ?",
          )
          .get(itemId) as {
          attempt_count: number;
          last_error_code: string | null;
        };
        return row.attempt_count === attempt && row.last_error_code
          ? true
          : undefined;
      }, 5_000);
      db!
        .prepare("UPDATE queue_items SET updated_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 60_000).toISOString(), itemId);
    }
    await waitFor(() => {
      const row = db!
        .prepare("SELECT state FROM queue_items WHERE id = ?")
        .get(itemId) as { state: string };
      return row.state === "review_required" ? true : undefined;
    }, 5_000);
    const uncertain = db!
      .prepare(
        "SELECT state, attempt_count, last_error_code FROM queue_items WHERE id = ?",
      )
      .get(itemId) as {
      state: string;
      attempt_count: number;
      last_error_code: string;
    };
    expect(uncertain).toMatchObject({
      state: "review_required",
      attempt_count: 4,
      last_error_code: "ADMISSION_UNCONFIRMED",
    });
    expect(fakeHermes.admissionRequests).toBe(4);
    expect(
      db!
        .prepare("SELECT pause_reason FROM conversations WHERE id = ?")
        .get(uncertainConversationId),
    ).toMatchObject({ pause_reason: "manual_resume_required" });

    await putDraft(nextConversationId, "Can use the freed slot", 0);
    const nextSent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${nextConversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000412",
        expected_draft_revision: 1,
      },
    });
    const nextItemId = (nextSent.json() as { queue_item: QueueItemView })
      .queue_item.id;
    await waitFor(() => {
      const row = db!
        .prepare("SELECT state FROM queue_items WHERE id = ?")
        .get(nextItemId) as { state: string };
      return row.state === "done" ? true : undefined;
    });
  }, 15_000);

  it("skips a paused queue head and dispatches another conversation", async () => {
    const pausedConversationId = await createMappedConversation();
    const runnableConversationId = await createMappedConversation();
    db!
      .prepare(
        "UPDATE conversations SET queue_paused = 1, pause_reason = 'manual_resume_required' WHERE id = ?",
      )
      .run(pausedConversationId);

    await putDraft(pausedConversationId, "Wait for resume", 0);
    const pausedSubmission = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${pausedConversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000405",
        expected_draft_revision: 1,
      },
    });
    expect(pausedSubmission.statusCode).toBe(202);
    const pausedItemId = (
      pausedSubmission.json() as { queue_item: QueueItemView }
    ).queue_item.id;
    // Keep the queued item unambiguously older than the runnable item.
    db!
      .prepare("UPDATE queue_items SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), pausedItemId);

    await putDraft(
      runnableConversationId,
      "Run while another queue is paused",
      0,
    );
    const runnableSubmission = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${runnableConversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000406",
        expected_draft_revision: 1,
      },
    });
    expect(runnableSubmission.statusCode).toBe(202);
    const runnableItemId = (
      runnableSubmission.json() as { queue_item: QueueItemView }
    ).queue_item.id;

    await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/conversations/${runnableConversationId}/queue?include_terminal=true`,
      });
      const item = (response.json() as QueueView).data.find(
        (entry) => entry.id === runnableItemId,
      );
      return item?.state === "done" ? item : undefined;
    });
    const pausedQueue = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${pausedConversationId}/queue`,
    });
    expect(pausedQueue.json()).toMatchObject({
      paused: true,
      data: [{ id: pausedItemId, state: "queued", local_run_id: null }],
    });

    const resume = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${pausedConversationId}/queue/resume`,
      payload: {},
    });
    expect(resume.statusCode).toBe(200);
    await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/conversations/${pausedConversationId}/queue?include_terminal=true`,
      });
      const item = (response.json() as QueueView).data.find(
        (entry) => entry.id === pausedItemId,
      );
      return item?.state === "done" ? item : undefined;
    });
  });

  it("expires recovery text before and after a server restart", async () => {
    const conversationId = await createMappedConversation();
    fakeHermes.failNextRun = true;
    await putDraft(conversationId, "Recover this failed submission", 0);
    const sent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000407",
        expected_draft_revision: 1,
      },
    });
    expect(sent.statusCode).toBe(202);
    const itemId = (sent.json() as { queue_item: QueueItemView }).queue_item.id;

    await waitFor(() => {
      const row = db!
        .prepare("SELECT last_error_code FROM queue_items WHERE id = ?")
        .get(itemId) as { last_error_code: string | null };
      return row.last_error_code ? true : undefined;
    });
    // Exhaust the remaining attempts without waiting through retry backoff.
    db!
      .prepare("UPDATE queue_items SET attempt_count = 4 WHERE id = ?")
      .run(itemId);

    await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/queue`,
      });
      const item = (response.json() as QueueView).data.find(
        (entry) => entry.id === itemId,
      );
      return item?.state === "review_required" ? item : undefined;
    }, 5_000);
    const copyBeforeExpiry = await app!.inject({
      method: "POST",
      url: `/api/v1/queue-items/${itemId}/copy-to-draft`,
      payload: { expected_draft_revision: 2 },
    });
    expect(copyBeforeExpiry.statusCode).toBe(200);
    expect(copyBeforeExpiry.json()).toMatchObject({
      draft: { content: "Recover this failed submission", revision: 3 },
    });

    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    db!
      .prepare("UPDATE queue_items SET recovery_expires_at = ? WHERE id = ?")
      .run(expiredAt, itemId);
    const queueAfterExpiry = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/queue`,
    });
    expect(queueAfterExpiry.json()).toMatchObject({
      data: [{ id: itemId, content: null, payload_available: false }],
    });
    const copyAfterExpiry = await app!.inject({
      method: "POST",
      url: `/api/v1/queue-items/${itemId}/copy-to-draft`,
      payload: { expected_draft_revision: 3, overwrite_nonempty: true },
    });
    expect(copyAfterExpiry.statusCode).toBe(409);
    expect(copyAfterExpiry.json()).toMatchObject({
      error: { message: "Queue item recovery payload is unavailable" },
    });

    await app!.close();
    app = null;
    app = buildServer(config, { db: db! });
    await app.ready();
    const row = db!
      .prepare(
        "SELECT payload_text, payload_expired_at FROM queue_items WHERE id = ?",
      )
      .get(itemId) as {
      payload_text: string | null;
      payload_expired_at: string | null;
    };
    expect(row).toEqual({
      payload_text: null,
      payload_expired_at: expiredAt,
    });
  });

  it("dispatches a draft through Hermes and reconciles the local run to done", async () => {
    const conversationId = await createMappedConversation();
    const sourceConversation = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}`,
    });
    const sourceSessionId = (
      sourceConversation.json() as { hermes_session_id: string }
    ).hermes_session_id;
    await putDraft(conversationId, "Run this through Fake Hermes", 0);

    const sent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000402",
        expected_draft_revision: 1,
      },
    });
    expect(sent.statusCode).toBe(202);

    const completedItem = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/queue?include_terminal=true`,
      });
      const queue = response.json() as QueueView;
      return queue.data.find(
        (item) => item.state === "done" && item.local_run_id !== null,
      );
    });
    expect(completedItem.content).toBeNull();

    const runResponse = await app!.inject({
      method: "GET",
      url: `/api/v1/runs/${completedItem.local_run_id}`,
    });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json()).toMatchObject({
      object: "emu_chat.run",
      id: completedItem.local_run_id,
      local_state: "reconciled",
      upstream_status: "completed",
    });
    expect(
      fakeHermes
        .getMessages(sourceSessionId)
        ?.map((message) => message.content),
    ).toContain("Run this through Fake Hermes");
  });

  it("returns masked tool calls and results through the message API", async () => {
    const conversationId = await createMappedConversation();
    const detail = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}`,
    });
    const sessionId = (detail.json() as { hermes_session_id: string })
      .hermes_session_id;
    const session = fakeHermes.sessions.get(sessionId)!;
    const secret = "SENTINEL123";
    session.messages.push(
      {
        id: 1,
        session_id: sessionId,
        role: "assistant",
        content: `TOKEN=${secret} before call`,
        reasoning: `password=${secret}`,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "terminal",
              arguments: JSON.stringify({
                command: `TOKEN=${secret} curl 'https://example.com/?token=${secret}'; echo done`,
              }),
            },
          },
          {
            id: "call_2",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({
                path: "/tmp/notes.txt",
                password: secret,
              }),
            },
          },
        ],
        timestamp: 1,
      },
      {
        id: 2,
        session_id: sessionId,
        role: "tool",
        content: JSON.stringify({
          output: `Authorization: Bearer ${secret}\nnormal line`,
        }),
        tool_call_id: "call_1",
        tool_name: "terminal",
        timestamp: 2,
      },
    );

    const response = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/messages`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    const items = (
      response.json() as {
        items: Array<{
          content: string;
          reasoning: string | null;
          tool_calls?: Array<{
            name: string;
            display_args?: string;
          }>;
        }>;
      }
    ).items;
    expect(items[0]?.content).toBe("TOKEN=[已隐藏] before call");
    expect(items[0]?.reasoning).toBe("password=[已隐藏]");
    expect(items[0]?.tool_calls?.[0]).toMatchObject({
      name: "terminal",
      display_args:
        "TOKEN=[已隐藏] curl 'https://example.com/?token=[已隐藏]'; echo done",
    });
    expect(items[0]?.tool_calls?.[1]?.name).toBe("read_file");
    expect(items[0]?.tool_calls?.[1]?.display_args).toContain(
      '"path": "/tmp/notes.txt"',
    );
    expect(JSON.parse(items[1]!.content)).toEqual({
      output: "Authorization: [已隐藏]\nnormal line",
    });
  });

  it("forwards tool approval through the run API and reconciles its terminal result", async () => {
    const conversationId = await createMappedConversation();
    fakeHermes.pauseNextRun = true;
    await putDraft(conversationId, "Run that needs approval", 0);

    const sent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000403",
        expected_draft_revision: 1,
      },
    });
    expect(sent.statusCode).toBe(202);

    const waitingItem = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/queue?include_terminal=true`,
      });
      const queue = response.json() as QueueView;
      return queue.data.find(
        (item) => item.state === "accepted" && item.local_run_id !== null,
      );
    });

    const waitingRun = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/runs/${waitingItem.local_run_id}`,
      });
      const run = response.json() as RunView;
      return run.upstream_status === "waiting_for_approval" && run.approval
        ? run
        : undefined;
    });
    expect(waitingRun.approval?.choices).toContain("once");

    const approval = await app!.inject({
      method: "POST",
      url: `/api/v1/runs/${waitingRun.id}/approval`,
      payload: { choice: "once", request_id: waitingRun.approval!.request_id },
    });
    expect(approval.statusCode).toBe(202);
    expect(waitingRun.hermes_run_id).not.toBeNull();
    fakeHermes.completeApprovalRun(waitingRun.hermes_run_id!);

    const reconciled = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/runs/${waitingRun.id}`,
      });
      const run = response.json() as RunView;
      return run.local_state === "reconciled" &&
        run.upstream_status === "completed"
        ? run
        : undefined;
    });
    expect(reconciled.approval).toBeNull();
  });

  it("keeps stopped follow-ups paused across restart and resumes them without replaying the cancelled item", async () => {
    const conversationId = await createMappedConversation();
    fakeHermes.pauseNextRun = true;
    await putDraft(conversationId, "Task to stop", 0);
    const sent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000408",
        expected_draft_revision: 1,
      },
    });
    expect(sent.statusCode).toBe(202);
    const itemId = (sent.json() as { queue_item: QueueItemView }).queue_item.id;
    const run = await waitFor(() => {
      const current = new RunRepository(db!).findByQueueItemId(itemId);
      return current?.local_state === "accepted" && current.hermes_run_id
        ? current
        : undefined;
    });
    await putDraft(conversationId, "Follow-up to resume", 2);
    const followUp = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000409",
        expected_draft_revision: 3,
      },
    });
    expect(followUp.statusCode).toBe(202);
    const followUpId = (followUp.json() as { queue_item: QueueItemView })
      .queue_item.id;
    const stop = await app!.inject({
      method: "POST",
      url: `/api/v1/runs/${run.id}/stop`,
      payload: {},
    });
    expect(stop.statusCode).toBe(202);
    const earlyResume = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/queue/resume`,
      payload: {},
    });
    expect(earlyResume.statusCode).toBe(409);
    fakeHermes.completeStoppedRun(run.hermes_run_id!);
    await waitFor(() =>
      new RunRepository(db!).findById(run.id)?.local_state === "reconciled"
        ? true
        : undefined,
    );
    await app!.close();
    app = buildServer(config, { db: db! });
    await app.ready();
    const paused = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/queue`,
    });
    expect(paused.json()).toMatchObject({
      paused: true,
      pause_reason: "user_stopped",
      data: [
        { id: itemId, state: "paused", content: "Task to stop" },
        { id: followUpId, state: "queued" },
      ],
    });
    const copy = await app.inject({
      method: "POST",
      url: `/api/v1/queue-items/${itemId}/copy-to-draft`,
      payload: { expected_draft_revision: 4, overwrite_nonempty: false },
    });
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toMatchObject({
      object: "emu_chat.recovery_copy",
      draft: { content: "Task to stop", revision: 5 },
      duplicate_risk: true,
    });
    // The server also protects drafts from another tab or an outdated revision.
    const overwrite = await app.inject({
      method: "POST",
      url: `/api/v1/queue-items/${itemId}/copy-to-draft`,
      payload: { expected_draft_revision: 5, overwrite_nonempty: false },
    });
    expect(overwrite.statusCode).toBe(409);
    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/queue/resume`,
      payload: {},
    });
    expect(resume.statusCode).toBe(200);
    await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/queue?include_terminal=true`,
      });
      const data = (response.json() as QueueView).data;
      if (data.find((item) => item.id === followUpId)?.state !== "done") return;
      expect(data.find((item) => item.id === itemId)?.state).toBe("paused");
      return true;
    });
    expect(fakeHermes.admissionRequests).toBe(2);
    const finalDraft = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/draft`,
    });
    expect(finalDraft.json()).toMatchObject({
      content: "Task to stop",
      revision: 5,
    });
  });

  it("restores fresh events after a transient connection failure and an active-run restart", async () => {
    const publish = vi.spyOn(SSEHub.prototype, "publishRunEvent");
    const conversationId = await createMappedConversation();
    fakeHermes.pauseNextRun = true;
    fakeHermes.eventStreamFailures = 1;
    await putDraft(conversationId, "Recover this stream", 0);
    await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000405",
        expected_draft_revision: 1,
      },
    });
    const run = await waitFor(() => {
      const current = new RunRepository(db!).findActiveByConversation(
        conversationId,
      );
      return current?.hermes_run_id && current.events_truncated
        ? current
        : undefined;
    });
    expect(fakeHermes.eventSubscriptions).toBe(1);
    fakeHermes.enqueueRunEvent(run.hermes_run_id!, "message.delta", {
      text: "same",
    });
    fakeHermes.enqueueRunEvent(run.hermes_run_id!, "tool.started", {
      tool: "test",
    });
    fakeHermes.enqueueRunEvent(run.hermes_run_id!, "tool.completed", {
      tool: "test",
      preview: "done",
    });
    await waitFor(() =>
      publish.mock.calls.some((args) => args[2] === "tool.completed")
        ? true
        : undefined,
    );
    expect(fakeHermes.eventSubscriptions).toBe(2);
    await app!.close();
    app = null;
    // This test double retains an unconsumed queue so we can exercise the allowed reconnect path.
    // The deployed Hermes may instead return 404 after deleting its transport.
    fakeHermes.enqueueRunEvent(run.hermes_run_id!, "message.delta", {
      text: "same",
    });
    fakeHermes.enqueueRunEvent(run.hermes_run_id!, "tool.started", {
      tool: "after_restart",
    });
    app = buildServer(config, { db: db! });
    await app.ready();
    await waitFor(() =>
      publish.mock.calls.some(
        (args) =>
          args[2] === "tool.started" && args[3].tool === "after_restart",
      )
        ? true
        : undefined,
    );
    expect(fakeHermes.eventSubscriptions).toBe(3);
    expect(
      publish.mock.calls.filter((args) => args[2] === "message.delta"),
    ).toHaveLength(2);
    expect(
      publish.mock.calls.filter((args) => args[2] === "tool.completed"),
    ).toHaveLength(1);
    expect(fakeHermes.admissionRequests).toBe(1);

    const waiting = (
      await app.inject({ method: "GET", url: `/api/v1/runs/${run.id}` })
    ).json() as RunView;
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${run.id}/approval`,
      payload: { choice: "once", request_id: waiting.approval!.request_id },
    });
    expect(approved.statusCode).toBe(202);
    fakeHermes.completeApprovalRun(run.hermes_run_id!);
    await waitFor(async () => {
      await app!.inject({ method: "GET", url: `/api/v1/runs/${run.id}` });
      return new RunRepository(db!).findById(run.id)?.local_state ===
        "reconciled"
        ? true
        : undefined;
    });
    expect(fakeHermes.admissionRequests).toBe(1);
  }, 8_000);

  it("reconciles an accepted run after a server restart without submitting it twice", async () => {
    const conversationId = await createMappedConversation();
    fakeHermes.pauseNextRun = true;
    await putDraft(conversationId, "Keep this run across restart", 0);

    const sent = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000404",
        expected_draft_revision: 1,
      },
    });
    expect(sent.statusCode).toBe(202);

    const accepted = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/queue?include_terminal=true`,
      });
      const item = (response.json() as QueueView).data[0];
      return item?.state === "accepted" && item.local_run_id ? item : undefined;
    });
    const runId = accepted.local_run_id!;
    const waiting = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}`,
      });
      const run = response.json() as RunView;
      return run.approval ? run : undefined;
    });
    const approved = await app!.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/approval`,
      payload: { choice: "once", request_id: waiting.approval!.request_id },
    });
    expect(approved.statusCode).toBe(202);

    await app!.close();
    app = null;
    fakeHermes.completeApprovalRun(waiting.hermes_run_id!);

    app = buildServer(config, { db: db! });
    await app.ready();
    const done = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/queue?include_terminal=true`,
      });
      const item = (response.json() as QueueView).data[0];
      return item?.state === "done" ? item : undefined;
    }, 5_000);
    expect(done.content).toBeNull();
    expect(new RunRepository(db!).findById(runId)).toMatchObject({
      local_state: "reconciled",
      upstream_status: "completed",
      events_truncated: 1,
    });
    expect(fakeHermes.runs.size).toBe(1);
  }, 8_000);
});
