import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  ConversationRepository,
  DraftRepository,
} from "../../src/server/db/repositories/conversation.repository.js";
import { LeaseRepository } from "../../src/server/db/repositories/lease.repository.js";
import { LocalConflictError } from "../../src/server/domain/errors.js";

describe("repository consistency and concurrency", () => {
  let db: Database.Database;
  let conversations: ConversationRepository;
  let drafts: DraftRepository;
  let leases: LeaseRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    conversations = new ConversationRepository(db);
    drafts = new DraftRepository(db);
    leases = new LeaseRepository(db);
  });

  afterEach(() => db.close());

  const addConversation = (id: string, sessionId = `session-${id}`) =>
    conversations.insert({
      id,
      hermes_profile: "default",
      hermes_session_id: sessionId,
    });

  it("rejects stale metadata and draft revisions without changing saved values", () => {
    const id = "cv_01956789-0000-7000-8000-000000000001";
    addConversation(id);
    conversations.updateMetadata(id, 0, { tags_json: '["current"]' });
    drafts.saveDraft(id, "current");
    drafts.saveDraft(id, "latest", 0);

    expect(() =>
      conversations.updateMetadata(id, 0, { tags_json: '["stale"]' }),
    ).toThrow(LocalConflictError);
    expect(() => drafts.saveDraft(id, "stale", 0)).toThrow(LocalConflictError);
    expect(conversations.findById(id)?.tags_json).toBe('["current"]');
    expect(drafts.findByConversationId(id)?.content).toBe("latest");
  });

  it("adopts only an empty projected session, preserving drafts on conflict", () => {
    const sourceId = "cv_01956789-0000-7000-8000-000000000002";
    const emptyTipId = "cv_01956789-0000-7000-8000-000000000003";
    addConversation(sourceId, "session-before-rollover");
    addConversation(emptyTipId, "session-effective-tip");
    drafts.saveDraft(emptyTipId, "");

    conversations.adoptEffectiveHermesSessionId(
      sourceId,
      "session-effective-tip",
    );
    expect(conversations.findBySessionId("session-effective-tip")?.id).toBe(
      sourceId,
    );
    expect(conversations.findById(emptyTipId)).toBeNull();

    const materialTipId = "cv_01956789-0000-7000-8000-000000000004";
    addConversation(materialTipId, "session-material-tip");
    drafts.saveDraft(materialTipId, "Do not discard this draft");
    expect(() =>
      conversations.adoptEffectiveHermesSessionId(
        sourceId,
        "session-material-tip",
      ),
    ).toThrow(LocalConflictError);
    expect(drafts.findByConversationId(materialTipId)?.content).toBe(
      "Do not discard this draft",
    );
  });

  it("fences competing lease owners and stale tokens", () => {
    expect(
      leases.acquire("global", "global", "worker-a", "token-a", 5_000),
    ).toBe(true);
    expect(
      leases.acquire("global", "global", "worker-b", "token-b", 5_000),
    ).toBe(false);
    expect(leases.renew("global", "global", "token-b", 5_000)).toBe(false);
    expect(leases.release("global", "global", "token-b")).toBe(false);
    expect(leases.renew("global", "global", "token-a", 5_000)).toBe(true);
    expect(leases.release("global", "global", "token-a")).toBe(true);
    expect(
      leases.acquire("global", "global", "worker-b", "token-b", 5_000),
    ).toBe(true);
  });
});
