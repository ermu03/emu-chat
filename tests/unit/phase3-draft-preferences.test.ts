import { afterEach, describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  ConversationRepository,
  DraftRepository,
  PreferencesRepository,
} from "../../src/server/db/repositories/conversation.repository.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { DraftPreferencesService } from "../../src/server/services/draft-preferences-service.js";
import {
  LocalConflictError,
  DraftConflictError,
  InvalidRequestError,
  PayloadTooLargeError,
} from "../../src/server/domain/errors.js";
import { LIMITS } from "../../src/shared/limits.js";

describe("Phase 3: Draft and Preferences Service", () => {
  let db: Database.Database;
  let draftRepo: DraftRepository;
  let preferencesRepo: PreferencesRepository;
  let service: DraftPreferencesService;
  const conversationId = "cv_01956789-0000-7000-8000-000000000301";

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    new ConversationRepository(db).insert({
      id: conversationId,
      hermes_profile: "default",
      hermes_session_id: "ses_draft_preferences_test",
    });
    draftRepo = new DraftRepository(db);
    preferencesRepo = new PreferencesRepository(db);
    service = new DraftPreferencesService(draftRepo, preferencesRepo);
  });

  afterEach(() => {
    db.close();
  });

  describe("Draft Management", () => {
    it("should return empty draft with revision 0 if none exists", () => {
      const draft = service.getDraft(conversationId);
      expect(draft.content).toBe("");
      expect(draft.revision).toBe(0);
      expect(draft.conversation_id).toBe(conversationId);
      expect(draft.object).toBe("emu_chat.draft");
    });

    it("should save and update draft with optimistic locking (revision)", () => {
      const draft1 = service.putDraft(conversationId, "hello world", 0);
      expect(draft1.content).toBe("hello world");
      expect(draft1.revision).toBe(0);

      const draft2 = service.putDraft(conversationId, "updated text", 0);
      expect(draft2.content).toBe("updated text");
      expect(draft2.revision).toBe(1);

      // Conflict when revision is wrong
      expect(() => {
        service.putDraft(conversationId, "conflict attempt", 0);
      }).toThrow(DraftConflictError);
    });

    it("should reject draft exceeding max input byte size", () => {
      const largeContent = "a".repeat(LIMITS.INPUT_MAX_BYTES + 1);
      expect(() => {
        service.putDraft(conversationId, largeContent, 0);
      }).toThrow(PayloadTooLargeError);
    });
  });

  describe("Preferences Management", () => {
    it("should load default preferences", () => {
      const prefs = service.getPreferences();
      expect(prefs.theme).toBe("system");
      expect(prefs.sidebar_width).toBe(320);
      expect(prefs.send_shortcut).toBe("enter");
      expect(prefs.revision).toBe(0);
    });

    it("should update preferences and bump revision", () => {
      const updated = service.putPreferences({
        theme: "dark",
        sidebar_width: 360,
        send_shortcut: "mod_enter",
        expected_revision: 0,
      });

      expect(updated.theme).toBe("dark");
      expect(updated.sidebar_width).toBe(360);
      expect(updated.send_shortcut).toBe("mod_enter");
      expect(updated.revision).toBe(1);

      // Conflict on stale revision
      expect(() => {
        service.putPreferences({
          theme: "light",
          sidebar_width: 300,
          send_shortcut: "enter",
          expected_revision: 0,
        });
      }).toThrow(LocalConflictError);
    });

    it("should reject invalid sidebar width or theme", () => {
      expect(() => {
        service.putPreferences({
          theme: "invalid" as any,
          sidebar_width: 320,
          send_shortcut: "enter",
          expected_revision: 0,
        });
      }).toThrow(InvalidRequestError);

      expect(() => {
        service.putPreferences({
          theme: "system",
          sidebar_width: LIMITS.SIDEBAR_WIDTH_MIN - 1,
          send_shortcut: "enter",
          expected_revision: 0,
        });
      }).toThrow(InvalidRequestError);
    });
  });
});
