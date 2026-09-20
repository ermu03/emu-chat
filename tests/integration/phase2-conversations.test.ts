import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { buildServer } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/config.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  ConversationRepository,
  DraftRepository,
} from "../../src/server/db/repositories/conversation.repository.js";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";

describe("Phase 2: Hermes adapter and conversations integration", () => {
  let app: FastifyInstance | null = null;
  let db: Database.Database | null = null;
  let fakeHermes: FakeHermesServer;
  let conversationRepo: ConversationRepository;
  let draftRepo: DraftRepository;

  beforeEach(async () => {
    fakeHermes = new FakeHermesServer();
    fakeHermes.createSession({ title: "Project Setup Discussion" });
    const hermesBaseUrl = await fakeHermes.start();

    db = new Database(":memory:");
    runMigrations(db);
    conversationRepo = new ConversationRepository(db);
    draftRepo = new DraftRepository(db);

    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: "/tmp/emu-chat-test",
      sqliteDbPath: ":memory:",
      hermesBaseUrl,
      hermesApiKey: "test-token",
      logLevel: "error",
      nodeEnv: "test",
      isProduction: false,
    };
    app = buildServer(config, { db });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (db?.open) db.close();
    db = null;
    await fakeHermes.close();
  });

  it("reports a healthy Hermes connection through the public status API", async () => {
    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "healthy",
      hermes_version: "0.21.3-test",
      missing_capabilities: [],
      lan_http_warning: false,
      pwa_secure_context_required: false,
    });
  });

  it("maps remote sessions to local conversations and creates only local projections", async () => {
    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/conversations",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ conversation_id: string; title: string }>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((item) => item.title)).toContain(
      "Project Setup Discussion",
    );

    const localConversations = conversationRepo.list();
    expect(localConversations).toHaveLength(2);
    expect(
      localConversations.every(
        (conversation) =>
          draftRepo.findByConversationId(conversation.id)?.content === "",
      ),
    ).toBe(true);

    const transcriptTables = db!
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%message%'",
      )
      .all();
    expect(transcriptTables).toHaveLength(0);
  });

  it("returns Hermes messages without persisting them and tracks effective session rotation", async () => {
    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/conversations",
    });
    const initialConversation = (
      listResponse.json() as {
        items: Array<{ conversation_id: string; hermes_session_id: string }>;
      }
    ).items.find((item) => item.hermes_session_id === "ses_test_1");
    expect(initialConversation).toBeDefined();

    const firstMessages = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${initialConversation!.conversation_id}/messages?limit=10&order=oldest`,
    });
    expect(firstMessages.statusCode).toBe(200);
    expect(firstMessages.json()).toMatchObject({
      effective_hermes_session_id: "ses_test_1",
      returned: 2,
      items: [
        { role: "user", content: "Hello Hermes" },
        { role: "assistant", content: "Hello from Fake Hermes." },
      ],
    });

    const rollover = fakeHermes.createSession({ title: "Rotated session" });
    fakeHermes.setEffectiveSessionIdForMessages("ses_test_1", rollover.id);
    const rotatedMessages = await app!.inject({
      method: "GET",
      url: `/api/v1/conversations/${initialConversation!.conversation_id}/messages`,
    });
    expect(rotatedMessages.statusCode).toBe(200);
    expect(rotatedMessages.json()).toMatchObject({
      effective_hermes_session_id: rollover.id,
      returned: 0,
    });
    expect(
      conversationRepo.findById(initialConversation!.conversation_id)
        ?.hermes_session_id,
    ).toBe(rollover.id);
  });

  it("uses CAS for local metadata and proxies Hermes metadata updates", async () => {
    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/conversations",
    });
    const conversation = (
      listResponse.json() as {
        items: Array<{
          conversation_id: string;
          hermes_session_id: string;
          local_revision: number;
        }>;
      }
    ).items.find((item) => item.hermes_session_id === "ses_test_1")!;

    const localUpdate = await app!.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversation.conversation_id}/local-metadata`,
      payload: {
        tags: ["work", "important"],
        expected_revision: conversation.local_revision,
      },
    });
    expect(localUpdate.statusCode).toBe(200);
    expect(localUpdate.json()).toMatchObject({
      tags: ["work", "important"],
      local_revision: 1,
    });

    const staleUpdate = await app!.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversation.conversation_id}/local-metadata`,
      payload: {
        tags: ["stale"],
        expected_revision: conversation.local_revision,
      },
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json()).toMatchObject({
      error: { code: "LOCAL_CONFLICT" },
    });

    const hermesUpdate = await app!.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversation.conversation_id}/hermes-metadata`,
      payload: { field: "title", value: "Renamed upstream session" },
    });
    expect(hermesUpdate.statusCode).toBe(200);
    expect(hermesUpdate.json()).toMatchObject({
      title: "Renamed upstream session",
    });
    expect(fakeHermes.getSession("ses_test_1")?.title).toBe(
      "Renamed upstream session",
    );
  });

  it("requires confirmation, prevents deletion while Hermes is active, then cleans both sides", async () => {
    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/conversations",
    });
    const conversation = (
      listResponse.json() as {
        items: Array<{ conversation_id: string; hermes_session_id: string }>;
      }
    ).items.find((item) => item.hermes_session_id === "ses_test_1")!;

    const mismatch = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.conversation_id}/delete`,
      payload: { expected_hermes_session_id: "wrong-session", confirmed: true },
    });
    expect(mismatch.statusCode).toBe(409);

    fakeHermes.activeAgents = 1;
    const activeAgentConflict = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.conversation_id}/delete`,
      payload: { expected_hermes_session_id: "ses_test_1", confirmed: true },
    });
    expect(activeAgentConflict.statusCode).toBe(409);

    fakeHermes.activeAgents = 0;
    const deleted = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.conversation_id}/delete`,
      payload: { expected_hermes_session_id: "ses_test_1", confirmed: true },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      conversation_id: conversation.conversation_id,
      hermes_deleted: true,
      local_cleaned: true,
    });
    expect(conversationRepo.findById(conversation.conversation_id)).toBeNull();
    expect(
      draftRepo.findByConversationId(conversation.conversation_id),
    ).toBeNull();
    expect(fakeHermes.getSession("ses_test_1")).toBeNull();
  });
});
