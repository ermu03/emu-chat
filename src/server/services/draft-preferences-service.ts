import type { DraftEntity, UiPreferencesEntity } from "../db/schema-types.js";
import {
  DraftRepository,
  PreferencesRepository,
} from "../db/repositories/conversation.repository.js";
import {
  DraftConflictError,
  LocalConflictError,
  InvalidRequestError,
  PayloadTooLargeError,
} from "../domain/errors.js";
import { LIMITS } from "../../shared/limits.js";

export interface DraftView {
  object: "emu_chat.draft";
  conversation_id: string;
  content: string;
  revision: number;
  updated_at: string | null;
}

export interface PreferencesView {
  object: "emu_chat.preferences";
  theme: "system" | "light" | "dark";
  sidebar_width: number;
  send_shortcut: "enter" | "mod_enter";
  revision: number;
  updated_at: string;
}

export class DraftPreferencesService {
  constructor(
    private draftRepo: DraftRepository,
    private preferencesRepo: PreferencesRepository,
  ) {}

  getDraft(conversationId: string): DraftView {
    const draft = this.draftRepo.findByConversationId(conversationId);
    if (!draft) {
      return {
        object: "emu_chat.draft",
        conversation_id: conversationId,
        content: "",
        revision: 0,
        updated_at: null,
      };
    }

    return this.toDraftView(draft);
  }

  putDraft(
    conversationId: string,
    content: string,
    expectedRevision: number,
  ): DraftView {
    if (typeof content !== "string") {
      throw new InvalidRequestError("Draft content must be a string");
    }

    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > LIMITS.INPUT_MAX_BYTES) {
      throw new PayloadTooLargeError(
        `Draft content exceeds max limit of ${LIMITS.INPUT_MAX_BYTES} bytes`,
        {
          limit_bytes: LIMITS.INPUT_MAX_BYTES,
        },
      );
    }

    if (
      typeof expectedRevision !== "number" ||
      expectedRevision < 0 ||
      !Number.isInteger(expectedRevision)
    ) {
      throw new InvalidRequestError(
        "expected_revision must be a non-negative integer",
      );
    }

    try {
      const updated = this.draftRepo.saveDraft(
        conversationId,
        content,
        expectedRevision,
      );
      return this.toDraftView(updated);
    } catch (err) {
      if (err instanceof LocalConflictError) {
        const current = this.draftRepo.findByConversationId(conversationId);
        throw new DraftConflictError("Draft revision conflict", {
          conversation_id: conversationId,
          expected_revision: expectedRevision,
          current_revision: current?.revision ?? 0,
        });
      }
      throw err;
    }
  }

  getPreferences(): PreferencesView {
    const prefs = this.preferencesRepo.get();
    return this.toPreferencesView(prefs);
  }

  putPreferences(input: {
    theme: "system" | "light" | "dark";
    sidebar_width: number;
    send_shortcut: "enter" | "mod_enter";
    expected_revision: number;
  }): PreferencesView {
    const { theme, sidebar_width, send_shortcut, expected_revision } = input;

    if (!["system", "light", "dark"].includes(theme)) {
      throw new InvalidRequestError("Invalid theme");
    }

    if (
      typeof sidebar_width !== "number" ||
      sidebar_width < LIMITS.SIDEBAR_WIDTH_MIN ||
      sidebar_width > LIMITS.SIDEBAR_WIDTH_MAX ||
      !Number.isFinite(sidebar_width)
    ) {
      throw new InvalidRequestError(
        `sidebar_width must be between ${LIMITS.SIDEBAR_WIDTH_MIN} and ${LIMITS.SIDEBAR_WIDTH_MAX}`,
      );
    }

    if (!["enter", "mod_enter"].includes(send_shortcut)) {
      throw new InvalidRequestError("Invalid send_shortcut");
    }

    if (
      typeof expected_revision !== "number" ||
      expected_revision < 0 ||
      !Number.isInteger(expected_revision)
    ) {
      throw new InvalidRequestError(
        "expected_revision must be a non-negative integer",
      );
    }

    const updated = this.preferencesRepo.update(expected_revision, {
      theme,
      sidebar_width,
      send_shortcut,
    });

    return this.toPreferencesView(updated);
  }

  private toDraftView(entity: DraftEntity): DraftView {
    return {
      object: "emu_chat.draft",
      conversation_id: entity.conversation_id,
      content: entity.content,
      revision: entity.revision,
      updated_at: entity.updated_at,
    };
  }

  private toPreferencesView(entity: UiPreferencesEntity): PreferencesView {
    return {
      object: "emu_chat.preferences",
      theme: entity.theme,
      sidebar_width: entity.sidebar_width,
      send_shortcut: entity.send_shortcut,
      revision: entity.revision,
      updated_at: entity.updated_at,
    };
  }
}
