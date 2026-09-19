import type Database from 'better-sqlite3';
import type { QueueItemEntity } from './schema-types.js';
import { ConflictError, NotFoundError, QueueFullError } from '../domain/errors.js';
import { MAX_PENDING_QUEUE_ITEMS_PER_CONVERSATION } from '../../shared/limits.js';

export class QueueRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): QueueItemEntity | null {
    const row = this.db.prepare('SELECT * FROM queue_items WHERE id = ?').get(id) as
      | QueueItemEntity
      | undefined;
    return row ?? null;
  }

  findByOperationId(operationId: string): QueueItemEntity | null {
    const row = this.db
      .prepare('SELECT * FROM queue_items WHERE operation_id = ?')
      .get(operationId) as QueueItemEntity | undefined;
    return row ?? null;
  }

  findByClientRequestId(clientRequestId: string): QueueItemEntity | null {
    const row = this.db
      .prepare('SELECT * FROM queue_items WHERE client_request_id = ?')
      .get(clientRequestId) as QueueItemEntity | undefined;
    return row ?? null;
  }

  listByConversation(
    conversationId: string,
    states?: QueueItemEntity['state'][]
  ): QueueItemEntity[] {
    if (!states || states.length === 0) {
      return this.db
        .prepare('SELECT * FROM queue_items WHERE conversation_id = ? ORDER BY fifo_seq ASC')
        .all(conversationId) as QueueItemEntity[];
    }

    const placeholders = states.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM queue_items
         WHERE conversation_id = ? AND state IN (${placeholders})
         ORDER BY fifo_seq ASC`
      )
      .all(conversationId, ...states) as QueueItemEntity[];
  }

  findActiveGlobal(): QueueItemEntity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM queue_items
         WHERE state IN ('dispatching', 'accepted', 'reconciling')
         LIMIT 1`
      )
      .get() as QueueItemEntity | undefined;
    return row ?? null;
  }

  findActiveByConversation(conversationId: string): QueueItemEntity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM queue_items
         WHERE conversation_id = ? AND state IN ('dispatching', 'accepted', 'reconciling')
         LIMIT 1`
      )
      .get(conversationId) as QueueItemEntity | undefined;
    return row ?? null;
  }

  findNextQueued(conversationId: string): QueueItemEntity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM queue_items
         WHERE conversation_id = ? AND state = 'queued'
         ORDER BY fifo_seq ASC
         LIMIT 1`
      )
      .get(conversationId) as QueueItemEntity | undefined;
    return row ?? null;
  }

  enqueue(
    item: Omit<
      QueueItemEntity,
      'fifo_seq' | 'revision' | 'attempt_count' | 'created_at' | 'updated_at'
    >
  ): QueueItemEntity {
    const executeTx = this.db.transaction(() => {
      // Check idempotency key or client_request_id first
      const existing = this.findByClientRequestId(item.client_request_id);
      if (existing) {
        return existing;
      }

      // Check queue limit per conversation for queued/dispatching
      const countRow = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM queue_items
           WHERE conversation_id = ? AND state IN ('queued', 'dispatching', 'accepted', 'reconciling')`
        )
        .get(item.conversation_id) as { count: number };

      if (countRow.count >= MAX_PENDING_QUEUE_ITEMS_PER_CONVERSATION) {
        throw new QueueFullError('Queue depth limit exceeded for conversation');
      }

      // Compute next fifo_seq
      const maxSeqRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(fifo_seq), 0) as max_seq FROM queue_items
           WHERE conversation_id = ?`
        )
        .get(item.conversation_id) as { max_seq: number };

      const nextSeq = maxSeqRow.max_seq + 1;
      const now = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO queue_items (
            id, conversation_id, operation_id, client_request_id, fifo_seq,
            state, payload_text, payload_sha256, payload_bytes, revision,
            idempotency_key, dispatch_session_id, attempt_count, first_attempt_at,
            admission_deadline_at, recovery_expires_at, payload_expired_at,
            payload_discarded_at, last_error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          item.id,
          item.conversation_id,
          item.operation_id,
          item.client_request_id,
          nextSeq,
          item.state,
          item.payload_text,
          item.payload_sha256,
          item.payload_bytes,
          item.idempotency_key,
          item.dispatch_session_id,
          item.first_attempt_at,
          item.admission_deadline_at,
          item.recovery_expires_at,
          item.payload_expired_at,
          item.payload_discarded_at,
          item.last_error_code,
          now,
          now
        );

      return this.findById(item.id)!;
    });

    return executeTx();
  }

  updateState(
    id: string,
    expectedRevision: number,
    patch: {
      state: QueueItemEntity['state'];
      dispatch_session_id?: string | null;
      attempt_count?: number;
      first_attempt_at?: string | null;
      admission_deadline_at?: string | null;
      recovery_expires_at?: string | null;
      payload_text?: string | null;
      payload_expired_at?: string | null;
      payload_discarded_at?: string | null;
      last_error_code?: string | null;
    }
  ): QueueItemEntity {
    const current = this.findById(id);
    if (!current) {
      throw new NotFoundError('Queue item not found');
    }
    if (current.revision !== expectedRevision) {
      throw new ConflictError('Queue item revision conflict');
    }

    const nextRevision = expectedRevision + 1;
    const now = new Date().toISOString();

    const dispatchSessionId =
      patch.dispatch_session_id !== undefined
        ? patch.dispatch_session_id
        : current.dispatch_session_id;
    const attemptCount =
      patch.attempt_count !== undefined ? patch.attempt_count : current.attempt_count;
    const firstAttemptAt =
      patch.first_attempt_at !== undefined ? patch.first_attempt_at : current.first_attempt_at;
    const admissionDeadlineAt =
      patch.admission_deadline_at !== undefined
        ? patch.admission_deadline_at
        : current.admission_deadline_at;
    const recoveryExpiresAt =
      patch.recovery_expires_at !== undefined
        ? patch.recovery_expires_at
        : current.recovery_expires_at;
    const payloadText =
      patch.payload_text !== undefined ? patch.payload_text : current.payload_text;
    const payloadExpiredAt =
      patch.payload_expired_at !== undefined
        ? patch.payload_expired_at
        : current.payload_expired_at;
    const payloadDiscardedAt =
      patch.payload_discarded_at !== undefined
        ? patch.payload_discarded_at
        : current.payload_discarded_at;
    const lastErrorCode =
      patch.last_error_code !== undefined ? patch.last_error_code : current.last_error_code;

    const res = this.db
      .prepare(
        `UPDATE queue_items
         SET state = ?, dispatch_session_id = ?, attempt_count = ?, first_attempt_at = ?,
             admission_deadline_at = ?, recovery_expires_at = ?, payload_text = ?,
             payload_expired_at = ?, payload_discarded_at = ?, last_error_code = ?,
             revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?`
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
        expectedRevision
      );

    if (res.changes === 0) {
      throw new ConflictError('Queue item revision conflict');
    }

    return this.findById(id)!;
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM queue_items WHERE id = ?').run(id);
    return res.changes > 0;
  }
}
