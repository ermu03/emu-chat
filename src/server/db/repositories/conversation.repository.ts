import type Database from 'better-sqlite3';
import type { ConversationEntity, DraftEntity, UiPreferencesEntity } from './schema-types.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';

export class ConversationRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): ConversationEntity | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationEntity
      | undefined;
    return row ?? null;
  }

  findBySessionId(sessionId: string): ConversationEntity | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE hermes_session_id = ?').get(sessionId) as
      | ConversationEntity
      | undefined;
    return row ?? null;
  }

  list(): ConversationEntity[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY custom_order ASC, created_at DESC')
      .all() as ConversationEntity[];
  }

  insert(entity: Omit<ConversationEntity, 'metadata_revision' | 'created_at' | 'updated_at'>): ConversationEntity {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversations (
          id, hermes_profile, hermes_session_id, tags_json, custom_order,
          metadata_revision, queue_paused, pause_reason, delete_state,
          delete_error_code, last_seen_upstream_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entity.id,
        entity.hermes_profile,
        entity.hermes_session_id,
        entity.tags_json,
        entity.custom_order,
        entity.queue_paused,
        entity.pause_reason,
        entity.delete_state,
        entity.delete_error_code,
        entity.last_seen_upstream_at,
        now,
        now
      );

    return this.findById(entity.id)!;
  }

  updateMetadata(
    id: string,
    expectedRevision: number,
    patch: {
      tags_json?: string;
      custom_order?: number | null;
    }
  ): ConversationEntity {
    const current = this.findById(id);
    if (!current) {
      throw new NotFoundError('Conversation not found');
    }
    if (current.metadata_revision !== expectedRevision) {
      throw new ConflictError('Conversation metadata revision conflict');
    }

    const nextRevision = expectedRevision + 1;
    const now = new Date().toISOString();
    const tags = patch.tags_json !== undefined ? patch.tags_json : current.tags_json;
    const order = patch.custom_order !== undefined ? patch.custom_order : current.custom_order;

    const res = this.db
      .prepare(
        `UPDATE conversations
         SET tags_json = ?, custom_order = ?, metadata_revision = ?, updated_at = ?
         WHERE id = ? AND metadata_revision = ?`
      )
      .run(tags, order, nextRevision, now, id, expectedRevision);

    if (res.changes === 0) {
      throw new ConflictError('Conversation metadata revision conflict');
    }

    return this.findById(id)!;
  }

  setQueuePaused(
    id: string,
    paused: boolean,
    pauseReason: string | null
  ): ConversationEntity {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE conversations
         SET queue_paused = ?, pause_reason = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(paused ? 1 : 0, paused ? pauseReason : null, now, id);

    if (res.changes === 0) {
      throw new NotFoundError('Conversation not found');
    }
    return this.findById(id)!;
  }

  setDeleteState(
    id: string,
    deleteState: 'none' | 'pending' | 'failed',
    deleteErrorCode: string | null = null
  ): ConversationEntity {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE conversations
         SET delete_state = ?, delete_error_code = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(deleteState, deleteErrorCode, now, id);

    if (res.changes === 0) {
      throw new NotFoundError('Conversation not found');
    }
    return this.findById(id)!;
  }

  updateHermesSessionId(id: string, newSessionId: string): ConversationEntity {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE conversations
         SET hermes_session_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(newSessionId, now, id);

    if (res.changes === 0) {
      throw new NotFoundError('Conversation not found');
    }
    return this.findById(id)!;
  }

  updateLastSeen(id: string, lastSeen: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conversations
         SET last_seen_upstream_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(lastSeen, now, id);
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return res.changes > 0;
  }
}

export class DraftRepository {
  constructor(private db: Database.Database) {}

  findByConversationId(conversationId: string): DraftEntity | null {
    const row = this.db
      .prepare('SELECT * FROM drafts WHERE conversation_id = ?')
      .get(conversationId) as DraftEntity | undefined;
    return row ?? null;
  }

  saveDraft(conversationId: string, content: string, expectedRevision?: number): DraftEntity {
    const current = this.findByConversationId(conversationId);
    const now = new Date().toISOString();

    if (!current) {
      // Create draft if not exists
      this.db
        .prepare(
          `INSERT INTO drafts (conversation_id, content, revision, created_at, updated_at)
           VALUES (?, ?, 0, ?, ?)`
        )
        .run(conversationId, content, now, now);
      return this.findByConversationId(conversationId)!;
    }

    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new ConflictError('Draft revision conflict');
    }

    const nextRevision = current.revision + 1;
    const res = this.db
      .prepare(
        `UPDATE drafts
         SET content = ?, revision = ?, updated_at = ?
         WHERE conversation_id = ? AND revision = ?`
      )
      .run(content, nextRevision, now, conversationId, current.revision);

    if (res.changes === 0) {
      throw new ConflictError('Draft revision conflict');
    }

    return this.findByConversationId(conversationId)!;
  }

  delete(conversationId: string): boolean {
    const res = this.db.prepare('DELETE FROM drafts WHERE conversation_id = ?').run(conversationId);
    return res.changes > 0;
  }
}

export class PreferencesRepository {
  constructor(private db: Database.Database) {}

  get(): UiPreferencesEntity {
    const row = this.db.prepare('SELECT * FROM ui_preferences WHERE id = 1').get() as
      | UiPreferencesEntity
      | undefined;
    if (!row) {
      // initialize default
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ui_preferences (id, theme, sidebar_width, send_shortcut, revision, updated_at)
           VALUES (1, 'system', 320, 'enter', 0, ?)`
        )
        .run(now);
      return this.db.prepare('SELECT * FROM ui_preferences WHERE id = 1').get() as UiPreferencesEntity;
    }
    return row;
  }

  update(
    expectedRevision: number,
    patch: {
      theme?: 'system' | 'light' | 'dark';
      sidebar_width?: number;
      send_shortcut?: 'enter' | 'mod_enter';
    }
  ): UiPreferencesEntity {
    const current = this.get();
    if (current.revision !== expectedRevision) {
      throw new ConflictError('Preferences revision conflict');
    }

    const nextRevision = expectedRevision + 1;
    const now = new Date().toISOString();
    const theme = patch.theme ?? current.theme;
    const sidebarWidth = patch.sidebar_width ?? current.sidebar_width;
    const sendShortcut = patch.send_shortcut ?? current.send_shortcut;

    const res = this.db
      .prepare(
        `UPDATE ui_preferences
         SET theme = ?, sidebar_width = ?, send_shortcut = ?, revision = ?, updated_at = ?
         WHERE id = 1 AND revision = ?`
      )
      .run(theme, sidebarWidth, sendShortcut, nextRevision, now, expectedRevision);

    if (res.changes === 0) {
      throw new ConflictError('Preferences revision conflict');
    }

    return this.get();
  }
}
