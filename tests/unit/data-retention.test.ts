import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ConversationRepository } from "../../src/server/db/repositories/conversation.repository.js";
import { QueueRepository } from "../../src/server/db/repositories/queue.repository.js";
import { RunRepository } from "../../src/server/db/repositories/run.repository.js";
import { DataRetentionService } from "../../src/server/services/data-retention-service.js";
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
      expiredPayloads: 1,
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
});
