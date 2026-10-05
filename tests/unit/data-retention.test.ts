import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ConversationRepository } from "../../src/server/db/repositories/conversation.repository.js";
import { QueueRepository } from "../../src/server/db/repositories/queue.repository.js";
import { RunRepository } from "../../src/server/db/repositories/run.repository.js";
import { DataRetentionService } from "../../src/server/services/data-retention-service.js";
import { makeMediaRunInput, sha256 } from "../../src/server/media/manifest.js";
import { MediaService } from "../../src/server/media/service.js";
import { MediaClient } from "../../src/server/media/client.js";
import { hasLocalMediaReference } from "../../src/server/media/sync.js";
import { QueueRunService } from "../../src/server/services/queue-run-service.js";
import { DraftRepository } from "../../src/server/db/repositories/conversation.repository.js";
import { LeaseRepository } from "../../src/server/db/repositories/lease.repository.js";
import { HermesAdapter } from "../../src/server/hermes/adapter.js";
import { HermesClient } from "../../src/server/hermes/client.js";
import type { MessageItem } from "../../src/shared/api-schemas.js";
import type { QueueItemEntity } from "../../src/server/db/schema-types.js";
import { LIMITS } from "../../src/shared/limits.js";

describe("data retention across queue and run states", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let runs: RunRepository;
  let retention: DataRetentionService;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    new ConversationRepository(db).insert({
      id: "cv_retention",
      hermes_profile: "default",
      hermes_session_id: "ses_retention",
    });
    queue = new QueueRepository(db);
    runs = new RunRepository(db);
    retention = new DataRetentionService(db, queue);
  });

  afterEach(() => db.close());

  it("keeps replayable and active records while pruning expired text and old terminal controls", () => {
    const now = new Date();
    const age = (durationMs: number) =>
      new Date(now.getTime() - durationMs).toISOString();
    let sequence = 0;
    const enqueue = (suffix: string) => {
      const id = `qi_retention_${suffix}`;
      const payload = `payload ${suffix}`;
      const createdAt = now.toISOString();
      db.prepare(
        `INSERT INTO queue_items (
          id, conversation_id, operation_id, client_request_id, fifo_seq,
          state, payload_text, payload_sha256, payload_bytes,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        "cv_retention",
        `op_retention_${suffix}`,
        `request-retention-${suffix}`,
        ++sequence,
        payload,
        createHash("sha256").update(payload).digest("hex"),
        Buffer.byteLength(payload, "utf8"),
        `idempotency-retention-${suffix}`,
        createdAt,
        createdAt,
      );
      return queue.findById(id)!;
    };
    const markDone = (suffix: string, updatedAt: string) => {
      const item = enqueue(suffix);
      queue.updateState(item.id, item.revision, {
        state: "done",
        dispatch_session_id: "ses_retention",
      });
      const run = runs.insert({
        id: `lr_retention_${suffix}`,
        queue_item_id: item.id,
        conversation_id: item.conversation_id,
        local_state: "reconciled",
        hermes_run_id: `run_retention_${suffix}`,
      });
      db.prepare("UPDATE queue_items SET updated_at = ? WHERE id = ?").run(
        updatedAt,
        item.id,
      );
      return { item, run };
    };

    const oldDone = markDone(
      "old_done",
      age(LIMITS.TERMINAL_CONTROL_RETENTION_MS + 60_000),
    );
    const recentDone = markDone(
      "recent_done",
      age(LIMITS.TERMINAL_CONTROL_RETENTION_MS - 60_000),
    );
    const activeCancellation = enqueue("active_cancellation");
    queue.updateState(activeCancellation.id, activeCancellation.revision, {
      state: "cancelled",
    });
    const activeRun = runs.insert({
      id: "lr_retention_active",
      queue_item_id: activeCancellation.id,
      conversation_id: activeCancellation.conversation_id,
      local_state: "accepted",
      hermes_run_id: "run_retention_active",
    });
    db.prepare("UPDATE queue_items SET updated_at = ? WHERE id = ?").run(
      age(LIMITS.TERMINAL_CONTROL_RETENTION_MS + 60_000),
      activeCancellation.id,
    );

    const expiredRecovery = enqueue("expired_recovery");
    const deadline = age(60_000);
    queue.updateState(expiredRecovery.id, expiredRecovery.revision, {
      state: "rejected",
      recovery_expires_at: deadline,
    });
    const rejectedRun = runs.insert({
      id: "lr_retention_rejected",
      queue_item_id: expiredRecovery.id,
      conversation_id: expiredRecovery.conversation_id,
      local_state: "rejected",
    });
    const liveRecovery = enqueue("live_recovery");
    queue.updateState(liveRecovery.id, liveRecovery.revision, {
      state: "rejected",
      recovery_expires_at: new Date(
        now.getTime() + LIMITS.RECOVERY_RETENTION_MS,
      ).toISOString(),
    });
    const activeRecovery = enqueue("active_recovery");
    queue.updateState(activeRecovery.id, activeRecovery.revision, {
      state: "review_required",
      recovery_expires_at: deadline,
    });
    const activeRecoveryRun = runs.insert({
      id: "lr_retention_active_recovery",
      queue_item_id: activeRecovery.id,
      conversation_id: activeRecovery.conversation_id,
      local_state: "reconciling",
      hermes_run_id: "run_retention_active_recovery",
    });

    expect(retention.runBatch(now)).toEqual({
      clearedPayloads: 1,
      deletedControls: 1,
    });
    expect(queue.findById(expiredRecovery.id)).toMatchObject({
      payload_text: null,
      payload_expired_at: deadline,
    });
    expect(queue.findById(liveRecovery.id)?.payload_text).toBe(
      "payload live_recovery",
    );
    expect(queue.findById(activeRecovery.id)?.payload_text).toBe(
      "payload active_recovery",
    );
    expect(
      queue.findByClientRequestId(recentDone.item.client_request_id),
    ).not.toBeNull();
    expect(queue.findById(oldDone.item.id)).toBeNull();
    expect(runs.findById(oldDone.run.id)).toBeNull();
    expect(queue.findById(activeCancellation.id)).not.toBeNull();
    expect(runs.findById(activeRun.id)).not.toBeNull();

    db.prepare("UPDATE queue_items SET updated_at = ? WHERE id = ?").run(
      age(LIMITS.DISCARDED_CONTROL_RETENTION_MS + 60_000),
      expiredRecovery.id,
    );
    runs.update(activeRecoveryRun.id, { local_state: "review_required" });
    expect(retention.runBatch(now).deletedControls).toBe(1);
    expect(queue.findById(expiredRecovery.id)).toBeNull();
    expect(runs.findById(rejectedRun.id)).toBeNull();
    expect(queue.findById(activeRecovery.id)).toMatchObject({
      payload_text: null,
      payload_expired_at: deadline,
    });
  });
  it("backfills and clears legacy frozen text in bounded batches while keeping proofs and active recovery", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 100 * 86400_000).toISOString();
    const future = new Date(now.getTime() + 86400_000).toISOString();
    const attachments = [
      { asset_id: "asset_first", sha256: "a".repeat(64) },
      { asset_id: "asset_second", sha256: "b".repeat(64) },
    ];
    let seq = 0;
    const imageItem = (
      suffix: string,
      state: QueueItemEntity["state"],
      textRemoved = false,
      deadline: string | null = old,
    ) => {
      const text = `private text ${suffix}`;
      const id = `qi_image_${suffix}`;
      const operationId = `op_image_${suffix}`;
      const manifest = makeMediaRunInput({
        scopeId: "cv_retention",
        operationId,
        sessionId: "ses_retention",
        userText: text,
        attachments,
      });
      db.prepare(
        `INSERT INTO queue_items
        (id,conversation_id,operation_id,client_request_id,fifo_seq,state,payload_text,payload_attachments_json,
         payload_run_input,payload_sha256,payload_bytes,idempotency_key,dispatch_session_id,recovery_expires_at,created_at,updated_at)
        VALUES (?,'cv_retention',?,?,?,?,?,?,?,?,?,?,'ses_retention',?,?,?)`,
      ).run(
        id,
        operationId,
        `request_${suffix}`,
        ++seq,
        state,
        textRemoved ? null : text,
        JSON.stringify(attachments),
        manifest.runInput,
        sha256(JSON.stringify({ version: 1, text, attachments })),
        text.length,
        `key_${suffix}`,
        deadline,
        old,
        old,
      );
      return { item: queue.findById(id)!, manifest, text };
    };
    for (let index = 0; index < 101; index++)
      imageItem(`bulk_${index}`, "review_required", true);
    const done = imageItem("done", "done", true, null);
    const discarded = imageItem("discarded", "review_required", true, future);
    db.prepare("UPDATE queue_items SET payload_discarded_at=? WHERE id=?").run(
      old,
      discarded.item.id,
    );
    const corrupt = imageItem("corrupt", "review_required", true);
    db.prepare("UPDATE queue_items SET payload_sha256=? WHERE id=?").run(
      "f".repeat(64),
      corrupt.item.id,
    );
    const live = imageItem("live", "paused", false, future);
    const active = imageItem("active", "review_required");
    runs.insert({
      id: "lr_image_active",
      queue_item_id: active.item.id,
      conversation_id: "cv_retention",
      local_state: "reconciling",
      hermes_run_id: "hr_active",
    });
    const submitting = imageItem("submitting", "dispatching");
    runs.insert({
      id: "lr_image_submitting",
      queue_item_id: submitting.item.id,
      conversation_id: "cv_retention",
      local_state: "submitting",
    });
    expect(
      queue.deleteExpiredControlRecords(
        now.toISOString(),
        now.toISOString(),
        100,
      ),
    ).toBe(0);
    db.exec(`CREATE TRIGGER fail_proof BEFORE INSERT ON media_submission_proofs
      WHEN NEW.operation_id='op_image_bulk_1' BEGIN SELECT RAISE(ABORT,'injected proof failure'); END;`);
    expect(() => retention.runBatch(now)).toThrow("injected proof failure");
    expect(queue.findById("qi_image_bulk_0")?.payload_run_input).not.toBeNull();
    expect(
      db.prepare("SELECT count(*) AS n FROM media_submission_proofs").get(),
    ).toEqual({ n: 0 });
    db.exec("DROP TRIGGER fail_proof");
    expect(retention.runBatch(now).clearedPayloads).toBe(100);
    // Recreating the service continues the persisted backlog, even review_required at 100 days.
    retention = new DataRetentionService(db, queue);
    expect(retention.runBatch(now)).toEqual({
      clearedPayloads: 4,
      deletedControls: 1,
    });
    expect(retention.runBatch(now)).toEqual({
      clearedPayloads: 0,
      deletedControls: 0,
    });
    expect(queue.findById(done.item.id)).toBeNull();
    expect(queue.findById(discarded.item.id)).toMatchObject({
      payload_text: null,
      payload_run_input: null,
      payload_discarded_at: old,
    });
    expect(queue.findById("qi_image_bulk_0")).toMatchObject({
      payload_run_input: null,
      payload_expired_at: old,
      updated_at: old,
    });
    expect(queue.findById(live.item.id)?.payload_run_input).toBe(
      live.manifest.runInput,
    );
    expect(queue.findById(active.item.id)?.payload_run_input).toBe(
      active.manifest.runInput,
    );
    expect(queue.findById(submitting.item.id)?.payload_run_input).toBe(
      submitting.manifest.runInput,
    );
    const proofs = db.prepare("SELECT * FROM media_submission_proofs").all();
    expect(proofs).toHaveLength(103);
    expect(JSON.stringify(proofs)).not.toContain("private text");
    expect(hasLocalMediaReference(db, "cv_retention", "asset_first")).toBe(
      true,
    );

    const service = new MediaService(
      db,
      new ConversationRepository(db),
      new MediaClient("http://unused", undefined),
    );
    const history: MessageItem = {
      id: 1,
      session_id: "ses_retention",
      role: "user",
      content: done.manifest.runInput,
      tool_call_id: null,
      tool_name: null,
      timestamp: 0,
      token_count: null,
      finish_reason: null,
      reasoning: null,
      display_kind: null,
    };
    const decorated = await service.decorateHistory("cv_retention", [history]);
    expect(decorated[0]?.content).toBe(done.text);
    const handoff = db
      .prepare("SELECT payload_json FROM media_outbox WHERE id=?")
      .get(`history_cv_retention_${done.item.operation_id}`) as {
      payload_json: string;
    };
    expect(JSON.parse(handoff.payload_json)).toMatchObject({
      queue_reference_id: `ref_queue_${done.item.id}`,
    });
    expect(decorated[0]?.attachments?.map((ref) => ref.asset_id)).toEqual([
      "asset_first",
      "asset_second",
    ]);
    const base = {
      scopeId: "cv_retention",
      operationId: done.item.operation_id,
      sessionId: "ses_retention",
      userText: done.text,
      attachments,
    };
    const forged = [
      { ...base, userText: "modified text" },
      { ...base, scopeId: "cv_other" },
      { ...base, operationId: "op_other" },
      { ...base, sessionId: "ses_other" },
      { ...base, attachments: [...attachments].reverse() },
    ];
    for (const value of forged) {
      const input = makeMediaRunInput(value).runInput;
      const result = await service.decorateHistory("cv_retention", [
        { ...history, content: input },
      ]);
      expect(result[0]?.content).toBe(input);
      expect(result[0]?.attachments).toBeUndefined();
    }
    const corruptedProof = db
      .prepare("SELECT 1 FROM media_submission_proofs WHERE operation_id=?")
      .get(corrupt.item.operation_id);
    expect(corruptedProof).toBeUndefined();
    expect(
      (
        await service.decorateHistory("cv_retention", [
          { ...history, content: corrupt.manifest.runInput },
        ])
      )[0]?.attachments,
    ).toBeUndefined();

    const mutations = new QueueRunService({
      db,
      conversationRepo: new ConversationRepository(db),
      draftRepo: new DraftRepository(db),
      queueRepo: queue,
      runRepo: runs,
      leaseRepo: new LeaseRepository(db),
      hermesAdapter: new HermesAdapter(
        new HermesClient({ baseUrl: "http://unused", token: "test" }),
      ),
      wakeCoordinator: () => {},
      reconcileCoordinator: async () => {},
      stopCoordinator: async () => {},
      approveCoordinator: async () => {},
    });
    expect(() => mutations.discardRecovery(active.item.id)).toThrow(
      "active Run",
    );
    expect(mutations.discardRecovery(live.item.id)).toMatchObject({
      content: null,
      payload_available: false,
    });
    expect(queue.findById(live.item.id)).toMatchObject({
      payload_text: null,
      payload_run_input: null,
    });
    const completed = imageItem("completed", "paused", false, future);
    queue.updateState(completed.item.id, completed.item.revision, {
      state: "done",
    });
    expect(queue.findById(completed.item.id)).toMatchObject({
      payload_text: null,
      payload_run_input: null,
    });
    const cancelled = imageItem("cancelled", "paused", false, future);
    queue.updateState(cancelled.item.id, cancelled.item.revision, {
      state: "cancelled",
    });
    expect(queue.findById(cancelled.item.id)).toMatchObject({
      payload_text: null,
      payload_run_input: null,
    });
  });
});
