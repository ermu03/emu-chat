import type Database from "better-sqlite3";
import type {
  ConversationEntity,
  DraftEntity,
  UiPreferencesEntity,
} from "../schema-types.js";
import { ConflictError, NotFoundError } from "../../domain/errors.js";
import { withImmediateTransaction } from "../transaction.js";

export class ConversationRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): ConversationEntity | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationEntity | undefined;
    return row ?? null;
  }

  findBySessionId(sessionId: string): ConversationEntity | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE hermes_session_id = ?")
      .get(sessionId) as ConversationEntity | undefined;
    return row ?? null;
  }

  list(): ConversationEntity[] {
    return this.db
      .prepare(
        "SELECT * FROM conversations ORDER BY custom_order ASC, created_at DESC",
      )
      .all() as ConversationEntity[];
  }

  insert(
    entity: Pick<
      ConversationEntity,
      "id" | "hermes_profile" | "hermes_session_id"
    > &
      Partial<
        Pick<
          ConversationEntity,
          | "tags_json"
          | "custom_order"
          | "metadata_revision"
          | "queue_paused"
          | "pause_reason"
          | "delete_state"
          | "delete_error_code"
          | "last_seen_upstream_at"
          | "created_at"
          | "updated_at"
        >
      >,
  ): ConversationEntity {
    const now = new Date().toISOString();
    const tagsJson = entity.tags_json ?? "[]";
    const queuePaused = entity.queue_paused ?? 0;
    const pauseReason = entity.pause_reason ?? null;
    const deleteState = entity.delete_state ?? "none";
    const deleteErrorCode = entity.delete_error_code ?? null;
    const lastSeenUpstreamAt = entity.last_seen_upstream_at ?? null;
    const metadataRevision = entity.metadata_revision ?? 0;
    const createdAt = entity.created_at ?? now;
    const updatedAt = entity.updated_at ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO conversations (
          id, hermes_profile, hermes_session_id, tags_json, custom_order,
          metadata_revision, queue_paused, pause_reason, delete_state,
          delete_error_code, last_seen_upstream_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.id,
        entity.hermes_profile,
        entity.hermes_session_id,
        tagsJson,
        entity.custom_order ?? null,
        metadataRevision,
        queuePaused,
        pauseReason,
        deleteState,
        deleteErrorCode,
        lastSeenUpstreamAt,
        createdAt,
        updatedAt,
      );

    return this.findById(entity.id)!;
  }

  updateMetadata(
    id: string,
    expectedRevision: number,
    patch: {
      tags_json?: string;
      custom_order?: number | null;
    },
  ): ConversationEntity {
    const current = this.findById(id);
    if (!current) {
      throw new NotFoundError("Conversation not found");
    }
    if (current.metadata_revision !== expectedRevision) {
      throw new ConflictError("Conversation metadata revision conflict");
    }

    const nextRevision = expectedRevision + 1;
    const now = new Date().toISOString();
    const tags =
      patch.tags_json !== undefined ? patch.tags_json : current.tags_json;
    const order =
      patch.custom_order !== undefined
        ? patch.custom_order
        : current.custom_order;

    const res = this.db
      .prepare(
        `UPDATE conversations
         SET tags_json = ?, custom_order = ?, metadata_revision = ?, updated_at = ?
         WHERE id = ? AND metadata_revision = ?`,
      )
      .run(tags, order, nextRevision, now, id, expectedRevision);

    if (res.changes === 0) {
      throw new ConflictError("Conversation metadata revision conflict");
    }

    return this.findById(id)!;
  }

  setQueuePaused(
    id: string,
    paused: boolean,
    pauseReason: string | null,
  ): ConversationEntity {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE conversations
         SET queue_paused = ?, pause_reason = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(paused ? 1 : 0, paused ? pauseReason : null, now, id);

    if (res.changes === 0) {
      throw new NotFoundError("Conversation not found");
    }
    return this.findById(id)!;
  }

  setDeleteState(
    id: string,
    deleteState: "none" | "pending" | "failed",
    deleteErrorCode: string | null = null,
  ): ConversationEntity {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE conversations
         SET delete_state = ?, delete_error_code = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(deleteState, deleteErrorCode, now, id);

    if (res.changes === 0) {
      throw new NotFoundError("Conversation not found");
    }
    return this.findById(id)!;
  }

  updateHermesSessionId(id: string, newSessionId: string): ConversationEntity {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE conversations
         SET hermes_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(newSessionId, now, id);

    if (res.changes === 0) {
      throw new NotFoundError("Conversation not found");
    }
    return this.findById(id)!;
  }

  updateLastSeen(id: string, lastSeen: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conversations
         SET last_seen_upstream_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(lastSeen, now, id);
  }

  delete(id: string): boolean {
    const res = this.db
      .prepare("DELETE FROM conversations WHERE id = ?")
      .run(id);
    return res.changes > 0;
  }
}

export class DraftRepository {
  constructor(private db: Database.Database) {}

  findByConversationId(conversationId: string): DraftEntity | null {
    const row = this.db
      .prepare("SELECT * FROM drafts WHERE conversation_id = ?")
      .get(conversationId) as DraftEntity | undefined;
    return row ?? null;
  }

  saveDraft(
    conversationId: string,
    content: string,
    expectedRevision?: number,
  ): DraftEntity {
    return withImmediateTransaction(this.db, () => {
      const current = this.findByConversationId(conversationId);
      const now = new Date().toISOString();

      if (!current) {
        if (expectedRevision !== undefined && expectedRevision !== 0) {
          throw new ConflictError("Draft revision conflict");
        }
        this.db
          .prepare(
            `INSERT INTO drafts (conversation_id, content, revision, created_at, updated_at)
             VALUES (?, ?, 0, ?, ?)`,
          )
          .run(conversationId, content, now, now);
        return this.findByConversationId(conversationId)!;
      }

      if (
        expectedRevision !== undefined &&
        current.revision !== expectedRevision
      ) {
        throw new ConflictError("Draft revision conflict");
      }

      const nextRevision = current.revision + 1;
      const expected = expectedRevision ?? current.revision;
      const res = this.db
        .prepare(
          `UPDATE drafts
           SET content = ?, revision = ?, updated_at = ?
           WHERE conversation_id = ? AND revision = ?`,
        )
        .run(content, nextRevision, now, conversationId, expected);

      if (res.changes === 0) {
        throw new ConflictError("Draft revision conflict");
      }

      return this.findByConversationId(conversationId)!;
    });
  }

  delete(conversationId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM drafts WHERE conversation_id = ?")
      .run(conversationId);
    return res.changes > 0;
  }
}

export class PreferencesRepository {
  constructor(private db: Database.Database) {}

  get(): UiPreferencesEntity {
    const row = this.db
      .prepare("SELECT * FROM ui_preferences WHERE id = 1")
      .get() as UiPreferencesEntity | undefined;
    if (!row) {
      // initialize default
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ui_preferences (id, theme, sidebar_width, send_shortcut, revision, updated_at)
           VALUES (1, 'system', 320, 'enter', 0, ?)`,
        )
        .run(now);
      return this.db
        .prepare("SELECT * FROM ui_preferences WHERE id = 1")
        .get() as UiPreferencesEntity;
    }
    return row;
  }

  update(
    expectedRevision: number,
    patch: {
      theme?: "system" | "light" | "dark";
      sidebar_width?: number;
      send_shortcut?: "enter" | "mod_enter";
    },
  ): UiPreferencesEntity {
    const current = this.get();
    if (current.revision !== expectedRevision) {
      throw new ConflictError("Preferences revision conflict");
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
         WHERE id = 1 AND revision = ?`,
      )
      .run(
        theme,
        sidebarWidth,
        sendShortcut,
        nextRevision,
        now,
        expectedRevision,
      );

    if (res.changes === 0) {
      throw new ConflictError("Preferences revision conflict");
    }

    return this.get();
  }
}
