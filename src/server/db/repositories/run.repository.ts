import type Database from 'better-sqlite3';
import type { RunEntity } from './schema-types.js';
import { NotFoundError } from '../domain/errors.js';

export class RunRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): RunEntity | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | RunEntity
      | undefined;
    return row ?? null;
  }

  findByQueueItemId(queueItemId: string): RunEntity | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE queue_item_id = ?')
      .get(queueItemId) as RunEntity | undefined;
    return row ?? null;
  }

  findByHermesRunId(hermesRunId: string): RunEntity | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE hermes_run_id = ?')
      .get(hermesRunId) as RunEntity | undefined;
    return row ?? null;
  }

  findActiveByConversation(conversationId: string): RunEntity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE conversation_id = ?
           AND local_state IN ('submitting', 'accepted', 'reconciling')
         LIMIT 1`
      )
      .get(conversationId) as RunEntity | undefined;
    return row ?? null;
  }

  findActiveAll(): RunEntity[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE local_state IN ('submitting', 'accepted', 'reconciling')`
      )
      .all() as RunEntity[];
  }

  insert(
    entity: Omit<
      RunEntity,
      | 'partial'
      | 'last_event_seq'
      | 'events_truncated'
      | 'created_at'
      | 'updated_at'
    >
  ): RunEntity {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (
          id, queue_item_id, conversation_id, hermes_run_id, local_state,
          upstream_status, partial, last_event_seq, last_event_name,
          events_truncated, last_error_code, last_status_checked_at,
          reconciliation_started_at, started_at, terminal_at, reconciled_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entity.id,
        entity.queue_item_id,
        entity.conversation_id,
        entity.hermes_run_id,
        entity.local_state,
        entity.upstream_status,
        entity.last_event_name,
        entity.last_error_code,
        entity.last_status_checked_at,
        entity.reconciliation_started_at,
        entity.started_at,
        entity.terminal_at,
        entity.reconciled_at,
        now,
        now
      );

    return this.findById(entity.id)!;
  }

  update(
    id: string,
    patch: {
      hermes_run_id?: string | null;
      local_state?: RunEntity['local_state'];
      upstream_status?: RunEntity['upstream_status'];
      partial?: 0 | 1;
      last_event_seq?: number;
      last_event_name?: string | null;
      events_truncated?: 0 | 1;
      last_error_code?: string | null;
      last_status_checked_at?: string | null;
      reconciliation_started_at?: string | null;
      terminal_at?: string | null;
      reconciled_at?: string | null;
    }
  ): RunEntity {
    const current = this.findById(id);
    if (!current) {
      throw new NotFoundError('Run not found');
    }

    const now = new Date().toISOString();
    const hermesRunId =
      patch.hermes_run_id !== undefined ? patch.hermes_run_id : current.hermes_run_id;
    const localState =
      patch.local_state !== undefined ? patch.local_state : current.local_state;
    const upstreamStatus =
      patch.upstream_status !== undefined ? patch.upstream_status : current.upstream_status;
    const partial = patch.partial !== undefined ? patch.partial : current.partial;
    const lastEventSeq =
      patch.last_event_seq !== undefined ? patch.last_event_seq : current.last_event_seq;
    const lastEventName =
      patch.last_event_name !== undefined ? patch.last_event_name : current.last_event_name;
    const eventsTruncated =
      patch.events_truncated !== undefined ? patch.events_truncated : current.events_truncated;
    const lastErrorCode =
      patch.last_error_code !== undefined ? patch.last_error_code : current.last_error_code;
    const lastStatusCheckedAt =
      patch.last_status_checked_at !== undefined
        ? patch.last_status_checked_at
        : current.last_status_checked_at;
    const reconciliationStartedAt =
      patch.reconciliation_started_at !== undefined
        ? patch.reconciliation_started_at
        : current.reconciliation_started_at;
    const terminalAt =
      patch.terminal_at !== undefined ? patch.terminal_at : current.terminal_at;
    const reconciledAt =
      patch.reconciled_at !== undefined ? patch.reconciled_at : current.reconciled_at;

    const res = this.db
      .prepare(
        `UPDATE runs
         SET hermes_run_id = ?, local_state = ?, upstream_status = ?, partial = ?,
             last_event_seq = ?, last_event_name = ?, events_truncated = ?,
             last_error_code = ?, last_status_checked_at = ?,
             reconciliation_started_at = ?, terminal_at = ?, reconciled_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        hermesRunId,
        localState,
        upstreamStatus,
        partial,
        lastEventSeq,
        lastEventName,
        eventsTruncated,
        lastErrorCode,
        lastStatusCheckedAt,
        reconciliationStartedAt,
        terminalAt,
        reconciledAt,
        now,
        id
      );

    if (res.changes === 0) {
      throw new NotFoundError('Run not found');
    }

    return this.findById(id)!;
  }
}
