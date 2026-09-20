import type Database from "better-sqlite3";
import type {
  ConversationEntity,
  DraftEntity,
  UiPreferencesEntity,
} from "../schema-types.js";
import {
  LocalConflictError,
  LocalNotFoundError,
  StateConflictError,
} from "../../domain/errors.js";
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
    return withImmediateTransaction(this.db, () => {
      const current = this.requireWritableConversation(id);
      if (current.metadata_revision !== expectedRevision) {
        throw new LocalConflictError("Conversation metadata revision conflict");
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
        throw new LocalConflictError("Conversation metadata revision conflict");
      }

      return this.findById(id)!;
    });
  }

  setQueuePaused(
    id: string,
    paused: boolean,
    pauseReason: string | null,
  ): ConversationEntity {
    return withImmediateTransaction(this.db, () => {
      this.requireWritableConversation(id);
      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          `UPDATE conversations
           SET queue_paused = ?, pause_reason = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(paused ? 1 : 0, paused ? pauseReason : null, now, id);

      if (res.changes === 0) {
        throw new LocalNotFoundError("Conversation not found");
      }
      return this.findById(id)!;
    });
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
      throw new LocalNotFoundError("Conversation not found");
    }
    return this.findById(id)!;
  }

  /**
   * Move a stable local conversation to Hermes' effective session segment.
   * A list refresh may have already created a projection for that segment.
   * It is safe to discard only the untouched projection created by that read.
   */
  adoptEffectiveHermesSessionId(
    id: string,
    newSessionId: string,
  ): ConversationEntity {
    return withImmediateTransaction(this.db, () => {
      const source = this.requireWritableConversation(id);
      if (source.hermes_session_id === newSessionId) return source;

      const target = this.findBySessionId(newSessionId);
      if (target && target.id !== source.id) {
        if (this.hasMaterialLocalState(target)) {
          throw new LocalConflictError(
            "Effective Hermes session already has local conversation state",
            {
              source_conversation_id: source.id,
              target_conversation_id: target.id,
              hermes_session_id: newSessionId,
            },
          );
        }
        // coordinator_leases intentionally has no foreign key to a
        // conversation, so remove the empty target's lease explicitly.
        this.db
          .prepare(
            "DELETE FROM coordinator_leases WHERE scope_type = 'conversation' AND scope_id = ?",
          )
          .run(target.id);
        this.db
          .prepare("DELETE FROM conversations WHERE id = ?")
          .run(target.id);
      }

      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          `UPDATE conversations
           SET hermes_session_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(newSessionId, now, source.id);
      if (res.changes !== 1) {
        throw new LocalNotFoundError("Conversation not found");
      }
      return this.findById(source.id)!;
    });
  }

  /** Atomically enter deletion before any upstream request can be awaited. */
  beginDeletion(
    id: string,
    expectedHermesSessionId: string,
  ): ConversationEntity {
    return withImmediateTransaction(this.db, () => {
      const current = this.findById(id);
      if (!current) throw new LocalNotFoundError("Conversation not found");
      if (current.hermes_session_id !== expectedHermesSessionId) {
        throw new LocalConflictError(
          "expected_hermes_session_id does not match the current mapping",
        );
      }
      if (current.delete_state === "pending") {
        throw new StateConflictError(
          "Conversation deletion is already pending",
          {
            current_state: current.delete_state,
          },
        );
      }
      return this.setDeleteState(id, "pending");
    });
  }

  updateLastSeen(id: string, lastSeen: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conversations
         SET last_seen_upstream_at = ?, updated_at = ?
         WHERE id = ? AND delete_state = 'none'`,
      )
      .run(lastSeen, now, id);
  }

  delete(id: string): boolean {
    return withImmediateTransaction(this.db, () => {
      // coordinator_leases intentionally has no conversation foreign key:
      // the global lease must survive while this conversation lease is removed.
      this.db
        .prepare(
          "DELETE FROM coordinator_leases WHERE scope_type = 'conversation' AND scope_id = ?",
        )
        .run(id);
      const res = this.db
        .prepare("DELETE FROM conversations WHERE id = ?")
        .run(id);
      return res.changes > 0;
    });
  }

  private requireWritableConversation(id: string): ConversationEntity {
    const conversation = this.findById(id);
    if (!conversation) throw new LocalNotFoundError("Conversation not found");
    if (conversation.delete_state !== "none") {
      throw new StateConflictError(
        "Conversation is unavailable while deletion is pending or failed",
        { current_state: conversation.delete_state },
      );
    }
    return conversation;
  }

  private hasMaterialLocalState(conversation: ConversationEntity): boolean {
    if (
      conversation.tags_json !== "[]" ||
      conversation.custom_order !== null ||
      conversation.metadata_revision !== 0 ||
      conversation.queue_paused !== 0 ||
      conversation.pause_reason !== null ||
      conversation.delete_state !== "none" ||
      conversation.delete_error_code !== null
    ) {
      return true;
    }

    const draft = this.db
      .prepare("SELECT content, revision FROM drafts WHERE conversation_id = ?")
      .get(conversation.id) as
      { content: string; revision: number } | undefined;
    if (draft && (draft.content !== "" || draft.revision !== 0)) return true;

    const hasQueue = this.db
      .prepare("SELECT 1 FROM queue_items WHERE conversation_id = ? LIMIT 1")
      .get(conversation.id);
    if (hasQueue) return true;

    const hasRun = this.db
      .prepare("SELECT 1 FROM runs WHERE conversation_id = ? LIMIT 1")
      .get(conversation.id);
    if (hasRun) return true;

    const hasLease = this.db
      .prepare(
        "SELECT 1 FROM coordinator_leases WHERE scope_type = 'conversation' AND scope_id = ? LIMIT 1",
      )
      .get(conversation.id);
    return hasLease !== undefined;
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
      const conversation = this.db
        .prepare("SELECT delete_state FROM conversations WHERE id = ?")
        .get(conversationId) as
        { delete_state: ConversationEntity["delete_state"] } | undefined;
      if (!conversation) throw new LocalNotFoundError("Conversation not found");
      if (conversation.delete_state !== "none") {
        throw new StateConflictError(
          "Conversation is unavailable while deletion is pending or failed",
          { current_state: conversation.delete_state },
        );
      }
      const current = this.findByConversationId(conversationId);
      const now = new Date().toISOString();

      if (!current) {
        if (expectedRevision !== undefined && expectedRevision !== 0) {
          throw new LocalConflictError("Draft revision conflict");
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
        throw new LocalConflictError("Draft revision conflict");
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
        throw new LocalConflictError("Draft revision conflict");
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
      throw new LocalConflictError("Preferences revision conflict");
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
      throw new LocalConflictError("Preferences revision conflict");
    }

    return this.get();
  }
}
