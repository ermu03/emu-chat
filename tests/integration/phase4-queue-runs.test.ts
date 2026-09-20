import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { buildServer } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/config.js";
import { runMigrations } from "../../src/server/db/migrate.js";
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
  object: string;
  paused: boolean;
  data: QueueItemView[];
};

type RunView = {
  id: string;
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

  beforeEach(async () => {
    fakeHermes = new FakeHermesServer();
    const hermesBaseUrl = await fakeHermes.start();
    db = new Database(":memory:");
    runMigrations(db);

    const config: AppConfig = {
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
      method: "GET",
      url: "/api/v1/conversations?session_id=ses_test_1",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ conversation_id: string }>;
    };
    expect(body.items).toHaveLength(1);
    return body.items[0]!.conversation_id;
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

  it("atomically turns a draft into a queued item, replays the same request, and honors queue item CAS", async () => {
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

    const staleDraft = await app!.inject({
      method: "PUT",
      url: `/api/v1/conversations/${conversationId}/draft`,
      payload: { content: "stale", expected_revision: 0 },
    });
    expect(staleDraft.statusCode).toBe(409);
    expect(staleDraft.json()).toMatchObject({
      error: { code: "DRAFT_CONFLICT" },
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
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toMatchObject({
      object: "emu_chat.queue",
      paused: true,
      data: [{ id: sent.queue_item.id, state: "queued" }],
    });

    const edited = await app!.inject({
      method: "PATCH",
      url: `/api/v1/queue-items/${sent.queue_item.id}`,
      payload: { content: "Edited queued content", expected_revision: 0 },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      id: sent.queue_item.id,
      state: "queued",
      content: "Edited queued content",
      revision: 1,
    });

    const cancelled = await app!.inject({
      method: "POST",
      url: `/api/v1/queue-items/${sent.queue_item.id}/cancel`,
      payload: { expected_revision: 1 },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      state: "cancelled",
      content: null,
      revision: 2,
    });

    const hiddenTerminal = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/queue`,
    });
    expect((hiddenTerminal.json() as QueueView).data).toEqual([]);
    const terminal = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/queue?include_terminal=true`,
    });
    expect((terminal.json() as QueueView).data).toMatchObject([
      { id: sent.queue_item.id, state: "cancelled", content: null },
    ]);
  });

  it("dispatches a draft through Hermes and reconciles the local run to done", async () => {
    const conversationId = await createMappedConversation();
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
      fakeHermes.getMessages("ses_test_1")?.map((message) => message.content),
    ).toContain("Run this through Fake Hermes");

    const incompatibleCursors = await app!.inject({
      method: "GET",
      url: `/api/v1/runs/${completedItem.local_run_id}/events?after=1`,
      headers: { "last-event-id": "2" },
    });
    expect(incompatibleCursors.statusCode).toBe(400);
    expect(incompatibleCursors.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
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
});
