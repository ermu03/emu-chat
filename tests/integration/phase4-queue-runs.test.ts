import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { buildServer } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/config.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { RunRepository } from "../../src/server/db/repositories/run.repository.js";
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
      nodeEnv: "test",
      isProduction: false,
    };
    app = buildServer(config, { db });
    await app.ready();
  });

  afterEach(async () => {
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
