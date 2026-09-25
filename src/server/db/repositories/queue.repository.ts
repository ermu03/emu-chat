import type Database from "better-sqlite3";
import type { QueueItemEntity } from "../schema-types.js";
import { LocalConflictError, LocalNotFoundError } from "../../domain/errors.js";

export class QueueRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): QueueItemEntity | null {
    const row = this.db
      .prepare("SELECT * FROM queue_items WHERE id = ?")
      .get(id) as QueueItemEntity | undefined;
    return row ?? null;
  }

  findByClientRequestId(clientRequestId: string): QueueItemEntity | null {
    const row = this.db
      .prepare("SELECT * FROM queue_items WHERE client_request_id = ?")
      .get(clientRequestId) as QueueItemEntity | undefined;
    return row ?? null;
  }

  listByConversation(
    conversationId: string,
    states?: QueueItemEntity["state"][],
  ): QueueItemEntity[] {
    if (!states || states.length === 0) {
      return this.db
        .prepare(
          "SELECT * FROM queue_items WHERE conversation_id = ? ORDER BY fifo_seq ASC",
        )
        .all(conversationId) as QueueItemEntity[];
    }

    const placeholders = states.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM queue_items
         WHERE conversation_id = ? AND state IN (${placeholders})
         ORDER BY fifo_seq ASC`,
      )
      .all(conversationId, ...states) as QueueItemEntity[];
  }

  findActiveGlobal(): QueueItemEntity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM queue_items
         WHERE state IN ('dispatching', 'accepted', 'reconciling')
         LIMIT 1`,
      )
      .get() as QueueItemEntity | undefined;
    return row ?? null;
  }

  findActiveByConversation(conversationId: string): QueueItemEntity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM queue_items
         WHERE conversation_id = ? AND state IN ('dispatching', 'accepted', 'reconciling')
         LIMIT 1`,
      )
      .get(conversationId) as QueueItemEntity | undefined;
    return row ?? null;
  }

  /** Return the oldest queued item from a conversation eligible for dispatch. */
  findNextGlobalQueued(): QueueItemEntity | null {
    const row = this.db
      .prepare(
        `SELECT queue_items.* FROM queue_items
         JOIN conversations ON conversations.id = queue_items.conversation_id
         WHERE queue_items.state = 'queued'
           AND conversations.queue_paused = 0
           AND conversations.delete_state = 'none'
         ORDER BY queue_items.created_at ASC, queue_items.fifo_seq ASC
         LIMIT 1`,
      )
      .get() as QueueItemEntity | undefined;
    return row ?? null;
  }

  updateState(
    id: string,
    expectedRevision: number,
    patch: {
      state: QueueItemEntity["state"];
      dispatch_session_id?: string | null;
      attempt_count?: number;
      first_attempt_at?: string | null;
      admission_deadline_at?: string | null;
      recovery_expires_at?: string | null;
      payload_text?: string | null;
      payload_expired_at?: string | null;
      payload_discarded_at?: string | null;
      last_error_code?: string | null;
    },
  ): QueueItemEntity {
    const current = this.findById(id);
    if (!current) {
      throw new LocalNotFoundError("Queue item not found");
    }
    if (current.revision !== expectedRevision) {
      throw new LocalConflictError("Queue item revision conflict");
    }

    const nextRevision = expectedRevision + 1;
    const now = new Date().toISOString();

    const dispatchSessionId =
      patch.dispatch_session_id !== undefined
        ? patch.dispatch_session_id
        : current.dispatch_session_id;
    const attemptCount =
      patch.attempt_count !== undefined
        ? patch.attempt_count
        : current.attempt_count;
    const firstAttemptAt =
      patch.first_attempt_at !== undefined
        ? patch.first_attempt_at
        : current.first_attempt_at;
    const admissionDeadlineAt =
      patch.admission_deadline_at !== undefined
        ? patch.admission_deadline_at
        : current.admission_deadline_at;
    const recoveryExpiresAt =
      patch.recovery_expires_at !== undefined
        ? patch.recovery_expires_at
        : current.recovery_expires_at;
    const payloadText =
      patch.payload_text !== undefined
        ? patch.payload_text
        : patch.state === "done" || patch.state === "cancelled"
          ? null
          : current.payload_text;
    const payloadExpiredAt =
      patch.payload_expired_at !== undefined
        ? patch.payload_expired_at
        : current.payload_expired_at;
    const payloadDiscardedAt =
      patch.payload_discarded_at !== undefined
        ? patch.payload_discarded_at
        : current.payload_discarded_at;
    const lastErrorCode =
      patch.last_error_code !== undefined
        ? patch.last_error_code
        : current.last_error_code;

    const res = this.db
      .prepare(
        `UPDATE queue_items
         SET state = ?, dispatch_session_id = ?, attempt_count = ?, first_attempt_at = ?,
             admission_deadline_at = ?, recovery_expires_at = ?, payload_text = ?,
             payload_expired_at = ?, payload_discarded_at = ?, last_error_code = ?,
             revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        patch.state,
        dispatchSessionId,
        attemptCount,
        firstAttemptAt,
        admissionDeadlineAt,
        recoveryExpiresAt,
        payloadText,
        payloadExpiredAt,
        payloadDiscardedAt,
        lastErrorCode,
        nextRevision,
        now,
        id,
        expectedRevision,
      );

    if (res.changes === 0) {
      throw new LocalConflictError("Queue item revision conflict");
    }

    return this.findById(id)!;
  }

  expireRecoveryPayloads(now: string, limit: number): number {
    const result = this.db
      .prepare(
        `UPDATE queue_items
         SET payload_text = NULL, payload_expired_at = recovery_expires_at,
             revision = revision + 1, updated_at = ?
         WHERE id IN (
           SELECT q.id FROM queue_items AS q
           WHERE q.state IN ('paused', 'review_required', 'rejected')
             AND q.payload_text IS NOT NULL
             AND q.recovery_expires_at IS NOT NULL
             AND q.recovery_expires_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM runs AS r
               WHERE r.queue_item_id = q.id
                 AND r.local_state IN ('submitting', 'accepted', 'reconciling')
             )
           ORDER BY q.recovery_expires_at ASC, q.id ASC
           LIMIT ?
         )`,
      )
      .run(now, now, limit);
    return result.changes;
  }

  deleteExpiredControlRecords(
    terminalCutoff: string,
    discardedCutoff: string,
    limit: number,
  ): number {
    const result = this.db
      .prepare(
        `DELETE FROM queue_items
         WHERE id IN (
           SELECT q.id FROM queue_items AS q
           WHERE q.state IN ('done', 'cancelled', 'paused', 'rejected')
             AND q.updated_at <= ?
             AND (
               q.state IN ('done', 'cancelled')
               OR (
                 q.state IN ('paused', 'rejected')
                 AND q.updated_at <= ?
                 AND q.payload_text IS NULL
                 AND (q.payload_expired_at IS NOT NULL
                      OR q.payload_discarded_at IS NOT NULL)
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM runs AS r
               WHERE r.queue_item_id = q.id
                 AND r.local_state NOT IN ('reconciled', 'rejected')
             )
           ORDER BY q.updated_at ASC, q.id ASC
           LIMIT ?
         )`,
      )
      .run(terminalCutoff, discardedCutoff, limit);
    return result.changes;
  }

  delete(id: string): boolean {
    const res = this.db.prepare("DELETE FROM queue_items WHERE id = ?").run(id);
    return res.changes > 0;
  }
}
