import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  ConversationRepository,
  DraftRepository,
} from "../../src/server/db/repositories/conversation.repository.js";
import { LeaseRepository } from "../../src/server/db/repositories/lease.repository.js";
import {
  HermesConflictError,
  HermesNotFoundError,
  HermesUnavailableError,
} from "../../src/server/domain/errors.js";
import { HermesAdapter } from "../../src/server/hermes/adapter.js";
import { HermesClient } from "../../src/server/hermes/client.js";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";

describe("Phase 6: Fake Hermes HTTP compatibility matrix", () => {
  let fakeHermes: FakeHermesServer;
  let db: Database.Database;
  let conversationRepo: ConversationRepository;
  let draftRepo: DraftRepository;
  let leaseRepo: LeaseRepository;
  let adapter: HermesAdapter;

  beforeEach(async () => {
    fakeHermes = new FakeHermesServer();
    const baseUrl = await fakeHermes.start();
    db = new Database(":memory:");
    runMigrations(db);
    conversationRepo = new ConversationRepository(db);
    draftRepo = new DraftRepository(db);
    leaseRepo = new LeaseRepository(db);
    adapter = new HermesAdapter(
      new HermesClient({
        baseUrl,
        token: "test-token",
        defaultTimeoutMs: 3_000,
      }),
    );
  });

  afterEach(async () => {
    if (db.open) db.close();
    await fakeHermes.close();
  });

  it("normalizes session list/detail/message responses and follows an effective session rotation", async () => {
    const created = await adapter.createSession({ title: "Matrix session" });
    const sessions = await adapter.listSessions({ limit: 10, offset: 0 });
    expect(sessions.sessions.map((session) => session.id)).toContain(
      created.id,
    );

    const detail = await adapter.getSession(created.id);
    expect(detail).toMatchObject({
      id: created.id,
      title: "Matrix session",
      pinned: false,
    });

    const initialMessages = await adapter.getSessionMessages("ses_test_1", {
      limit: 10,
    });
    expect(initialMessages).toMatchObject({
      session_id: "ses_test_1",
      total: 2,
    });
    expect(initialMessages.messages.map((message) => message.content)).toEqual([
      "Hello Hermes",
      "Hello from Fake Hermes.",
    ]);

    fakeHermes.setEffectiveSessionIdForMessages("ses_test_1", created.id);
    const rotated = await adapter.getSessionMessages("ses_test_1");
    expect(rotated).toMatchObject({ session_id: created.id, total: 0 });
  });

  it("supports run admission replay, streamed events, and idempotency conflicts", async () => {
    const session = await adapter.createSession({ title: "Run matrix" });
    const first = await adapter.startRun(session.id, {
      prompt: "First prompt",
      idempotency_key: "matrix-idempotency-key",
    });
    expect(first).toMatchObject({ status: "started", replayed: false });

    const eventTypes: string[] = [];
    for await (const event of adapter.streamEvents(session.id, first.run_id)) {
      eventTypes.push(event.type);
    }
    expect(eventTypes).toEqual(["run.completed"]);

    const replay = await adapter.startRun(session.id, {
      prompt: "First prompt",
      idempotency_key: "matrix-idempotency-key",
    });
    expect(replay).toEqual({
      run_id: first.run_id,
      status: "started",
      replayed: true,
    });

    await expect(
      adapter.startRun(session.id, {
        prompt: "Different prompt",
        idempotency_key: "matrix-idempotency-key",
      }),
    ).rejects.toBeInstanceOf(HermesConflictError);
  });

  it("supports approval once and deny choices plus stopping a pending run", async () => {
    const session = await adapter.createSession({ title: "Approval matrix" });

    fakeHermes.pauseNextRun = true;
    const approved = await adapter.startRun(session.id, {
      prompt: "Needs approval once",
    });
    expect((await adapter.getRunStatus(approved.run_id)).status).toBe(
      "waiting_for_approval",
    );
    await adapter.submitApproval(approved.run_id, "once");
    expect((await adapter.getRunStatus(approved.run_id)).status).toBe(
      "completed",
    );

    fakeHermes.pauseNextRun = true;
    const denied = await adapter.startRun(session.id, {
      prompt: "Needs denial",
    });
    await adapter.submitApproval(denied.run_id, "deny");
    expect((await adapter.getRunStatus(denied.run_id)).status).toBe(
      "cancelled",
    );

    fakeHermes.pauseNextRun = true;
    const stopped = await adapter.startRun(session.id, {
      prompt: "Needs stop",
    });
    await adapter.stopRun(stopped.run_id);
    expect((await adapter.getRunStatus(stopped.run_id)).status).toBe(
      "cancelled",
    );
  });

  it("maps deletion and availability failures while local drafts remain available offline", async () => {
    const upstream = await adapter.createSession({ title: "Delete matrix" });
    await adapter.deleteSession(upstream.id);
    await expect(adapter.getSession(upstream.id)).rejects.toBeInstanceOf(
      HermesNotFoundError,
    );

    const localConversationId = "cv_01956789-0000-7000-8000-000000000601";
    conversationRepo.insert({
      id: localConversationId,
      hermes_profile: "default",
      hermes_session_id: "ses_offline_local",
    });
    draftRepo.saveDraft(
      localConversationId,
      "Retained while Hermes is unavailable",
    );

    fakeHermes.simulateFault({
      errorType: "network_error",
      message: "Hermes offline",
    });
    await expect(adapter.listSessions()).rejects.toBeInstanceOf(
      HermesUnavailableError,
    );
    expect(draftRepo.findByConversationId(localConversationId)?.content).toBe(
      "Retained while Hermes is unavailable",
    );
  });

  it("fences global and conversation leases by token", () => {
    expect(
      leaseRepo.acquire(
        "global",
        "global",
        "worker-a",
        "global-token-a",
        60_000,
      ),
    ).toBe(true);
    expect(
      leaseRepo.acquire(
        "global",
        "global",
        "worker-b",
        "global-token-b",
        60_000,
      ),
    ).toBe(false);
    expect(leaseRepo.release("global", "global", "global-token-a")).toBe(true);
    expect(
      leaseRepo.acquire(
        "global",
        "global",
        "worker-b",
        "global-token-b",
        60_000,
      ),
    ).toBe(true);

    const conversationId = "cv_01956789-0000-7000-8000-000000000602";
    expect(
      leaseRepo.acquire(
        "conversation",
        conversationId,
        "worker-a",
        "conversation-token-a",
        60_000,
      ),
    ).toBe(true);
    expect(
      leaseRepo.acquire(
        "conversation",
        conversationId,
        "worker-b",
        "conversation-token-b",
        60_000,
      ),
    ).toBe(false);
  });
});
