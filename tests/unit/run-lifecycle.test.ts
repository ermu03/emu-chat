import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionCoordinator } from "../../src/server/coordinator/admission-coordinator.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ConversationRepository } from "../../src/server/db/repositories/conversation.repository.js";
import { LeaseRepository } from "../../src/server/db/repositories/lease.repository.js";
import { QueueRepository } from "../../src/server/db/repositories/queue.repository.js";
import { RunRepository } from "../../src/server/db/repositories/run.repository.js";
import type { HermesAdapter } from "../../src/server/hermes/adapter.js";
import type { HermesRunStatusResponse } from "../../src/shared/hermes-schemas.js";
import { SSEHub } from "../../src/server/sse/sse-hub.js";

describe("Run lifecycle write fencing", () => {
  const databases: Database.Database[] = [];
  const hubs: SSEHub[] = [];
  const coordinators: AdmissionCoordinator[] = [];

  afterEach(() => {
    for (const coordinator of coordinators) coordinator.stop();
    for (const hub of hubs) hub.close();
    for (const db of databases) db.close();
    coordinators.length = 0;
    hubs.length = 0;
    databases.length = 0;
  });

  it("does not let an old running response replace a committed terminal result", async () => {
    const db = new Database(":memory:");
    databases.push(db);
    runMigrations(db);
    const conversations = new ConversationRepository(db);
    const queues = new QueueRepository(db);
    const runs = new RunRepository(db);
    const leases = new LeaseRepository(db);
    const conversationId = "cv_00000000-0000-4000-8000-000000000501";
    const itemId = "qi_00000000-0000-4000-8000-000000000501";
    const runId = "lr_00000000-0000-4000-8000-000000000501";
    const sessionId = "ses_race_test";
    const prompt = "Check lifecycle ordering";
    const now = new Date().toISOString();
    conversations.insert({
      id: conversationId,
      hermes_profile: "default",
      hermes_session_id: sessionId,
    });
    db.prepare(
      `INSERT INTO queue_items (
         id, conversation_id, operation_id, client_request_id, fifo_seq,
         state, payload_text, payload_sha256, payload_bytes, revision,
         idempotency_key, dispatch_session_id, attempt_count,
         first_attempt_at, admission_deadline_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'accepted', ?, ?, ?, 0, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      itemId,
      conversationId,
      "op_00000000-0000-4000-8000-000000000501",
      "00000000-0000-4000-8000-000000000501",
      prompt,
      createHash("sha256").update(prompt).digest("hex"),
      Buffer.byteLength(prompt),
      "ec_00000000-0000-4000-8000-000000000501",
      sessionId,
      now,
      new Date(Date.now() + 60_000).toISOString(),
      now,
      now,
    );
    runs.insert({
      id: runId,
      queue_item_id: itemId,
      conversation_id: conversationId,
      local_state: "accepted",
      hermes_run_id: "run_race_test",
      upstream_status: "running",
    });

    let releaseStale!: (status: HermesRunStatusResponse) => void;
    const staleStatus = new Promise<HermesRunStatusResponse>((resolve) => {
      releaseStale = resolve;
    });
    const oldAdapter = {
      getRunStatus: vi.fn(() => staleStatus),
    } as unknown as HermesAdapter;
    const newAdapter = {
      getRunStatus: vi.fn(async () => ({
        run_id: "run_race_test",
        status: "completed",
        partial: false,
      })),
      getSessionMessages: vi.fn(async () => ({
        object: "list",
        session_id: sessionId,
        data: [],
      })),
    } as unknown as HermesAdapter;
    const oldHub = new SSEHub();
    const newHub = new SSEHub();
    hubs.push(oldHub, newHub);
    const oldCoordinator = new AdmissionCoordinator(
      db,
      queues,
      runs,
      leases,
      conversations,
      oldAdapter,
      oldHub,
    );
    const newCoordinator = new AdmissionCoordinator(
      db,
      queues,
      runs,
      leases,
      conversations,
      newAdapter,
      newHub,
    );
    coordinators.push(oldCoordinator, newCoordinator);

    const stalePass = oldCoordinator.reconcileRun(runId);
    expect(oldAdapter.getRunStatus).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE coordinator_leases SET expires_at = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
    );
    await newCoordinator.reconcileRun(runId);
    releaseStale({
      run_id: "run_race_test",
      status: "running",
      partial: false,
    });
    await stalePass;

    expect(runs.findById(runId)).toMatchObject({
      local_state: "reconciled",
      upstream_status: "completed",
    });
    expect(queues.findById(itemId)).toMatchObject({ state: "done" });
    expect(conversations.findById(conversationId)).toMatchObject({
      queue_paused: 0,
    });
  });

  it("replays an in-flight admission after coordinator restart and ignores the old callback", async () => {
    const db = new Database(":memory:");
    databases.push(db);
    runMigrations(db);
    const conversations = new ConversationRepository(db);
    const queues = new QueueRepository(db);
    const runs = new RunRepository(db);
    const leases = new LeaseRepository(db);
    const conversationId = "cv_00000000-0000-4000-8000-000000000502";
    const itemId = "qi_00000000-0000-4000-8000-000000000502";
    const sessionId = "ses_pending_admission";
    const prompt = "Resume the original submission";
    const key = "ec_00000000-0000-4000-8000-000000000502";
    const now = new Date().toISOString();
    conversations.insert({
      id: conversationId,
      hermes_profile: "default",
      hermes_session_id: sessionId,
    });
    db.prepare(
      `INSERT INTO queue_items (
         id, conversation_id, operation_id, client_request_id, fifo_seq,
         state, payload_text, payload_sha256, payload_bytes, revision,
         idempotency_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'queued', ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      itemId,
      conversationId,
      "op_00000000-0000-4000-8000-000000000502",
      "00000000-0000-4000-8000-000000000502",
      prompt,
      createHash("sha256").update(prompt).digest("hex"),
      Buffer.byteLength(prompt),
      key,
      now,
      now,
    );

    let resolveOld!: (value: {
      run_id: string;
      status: "started";
      replayed: boolean;
    }) => void;
    const pending = new Promise<{
      run_id: string;
      status: "started";
      replayed: boolean;
    }>((resolve) => {
      resolveOld = resolve;
    });
    const oldAdapter = {
      startRun: vi.fn(() => pending),
    } as unknown as HermesAdapter;
    const replayAdapter = {
      startRun: vi.fn(async () => ({
        run_id: "run_original",
        status: "started" as const,
        replayed: true,
      })),
      streamEvents: vi.fn(async function* () {
        yield { type: "run.completed", data: {} };
      }),
      getRunStatus: vi.fn(async () => ({
        run_id: "run_original",
        status: "completed" as const,
        partial: false,
      })),
      getSessionMessages: vi.fn(async () => ({
        object: "list",
        session_id: sessionId,
        data: [],
      })),
    } as unknown as HermesAdapter;
    const oldHub = new SSEHub();
    const replayHub = new SSEHub();
    hubs.push(oldHub, replayHub);
    const oldCoordinator = new AdmissionCoordinator(
      db,
      queues,
      runs,
      leases,
      conversations,
      oldAdapter,
      oldHub,
    );
    const replayCoordinator = new AdmissionCoordinator(
      db,
      queues,
      runs,
      leases,
      conversations,
      replayAdapter,
      replayHub,
    );
    coordinators.push(oldCoordinator, replayCoordinator);

    await oldCoordinator.tick();
    expect(oldAdapter.startRun).toHaveBeenCalledWith(sessionId, {
      prompt,
      idempotency_key: key,
    });
    expect(queues.findById(itemId)).toMatchObject({
      state: "dispatching",
      attempt_count: 1,
    });
    oldCoordinator.stop();
    await replayCoordinator.tick();
    expect(replayAdapter.startRun).toHaveBeenCalledWith(sessionId, {
      prompt,
      idempotency_key: key,
    });
    await vi.waitFor(() => {
      expect(queues.findById(itemId)?.state).toBe("done");
    });
    const committedRun = runs.findByQueueItemId(itemId);
    expect(committedRun).toMatchObject({
      hermes_run_id: "run_original",
      local_state: "reconciled",
    });

    resolveOld({ run_id: "run_original", status: "started", replayed: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs.findByQueueItemId(itemId)).toMatchObject({
      hermes_run_id: "run_original",
      local_state: "reconciled",
      upstream_status: "completed",
    });
    expect(queues.findById(itemId)?.attempt_count).toBe(2);
  });
});
