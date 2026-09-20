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
import { LeaseRepository } from "../../src/server/db/repositories/lease.repository.js";
import { QueueRepository } from "../../src/server/db/repositories/queue.repository.js";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";

describe("Phase 2: Hermes adapter and conversations integration", () => {
  let app: FastifyInstance | null = null;
  let db: Database.Database | null = null;
  let fakeHermes: FakeHermesServer;
  let conversationRepo: ConversationRepository;
  let draftRepo: DraftRepository;
  let leaseRepo: LeaseRepository;
  let queueRepo: QueueRepository;

  beforeEach(async () => {
    fakeHermes = new FakeHermesServer();
    fakeHermes.createSession({ title: "Project Setup Discussion" });
    const hermesBaseUrl = await fakeHermes.start();

    db = new Database(":memory:");
    runMigrations(db);
    conversationRepo = new ConversationRepository(db);
    draftRepo = new DraftRepository(db);
    leaseRepo = new LeaseRepository(db);
    queueRepo = new QueueRepository(db);
    conversationRepo.insert({
      id: "cv_01956789-0000-7000-8000-000000000201",
      hermes_profile: "default",
      hermes_session_id: "ses_test_1",
    });
    draftRepo.saveDraft("cv_01956789-0000-7000-8000-000000000201", "");

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

  it("lists only locally registered conversations", async () => {
    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/conversations",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ conversation_id: string; title: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items.map((item) => item.title)).toContain("Test session");

    const localConversations = conversationRepo.list();
    expect(localConversations).toHaveLength(1);
    expect(
      localConversations.every(
        (conversation) =>
          draftRepo.findByConversationId(conversation.id)?.content === "",
      ),
    ).toBe(true);
    expect(
      localConversations.some(
        (conversation) =>
          conversation.hermes_session_id === "ses_test_2" ||
          conversation.hermes_session_id === "ses_test_3",
      ),
    ).toBe(false);

    const transcriptTables = db!
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%message%'",
      )
      .all();
    expect(transcriptTables).toHaveLength(0);
  });

  it("adopts an effective session when its empty tip is already locally projected", async () => {
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
    const tipProjection = conversationRepo.insert({
      id: "cv_01956789-0000-7000-8000-000000000202",
      hermes_profile: "default",
      hermes_session_id: rollover.id,
    });
    draftRepo.saveDraft(tipProjection.id, "");

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
    expect(conversationRepo.findById(tipProjection.id)).toBeNull();
    expect(conversationRepo.findBySessionId(rollover.id)?.id).toBe(
      initialConversation!.conversation_id,
    );
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

  it("rejects conversation writes after deletion is pending or failed", async () => {
    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/conversations",
    });
    const conversation = (
      listResponse.json() as {
        items: Array<{
          conversation_id: string;
          hermes_session_id: string;
        }>;
      }
    ).items.find((item) => item.hermes_session_id === "ses_test_1")!;
    // Keep the fixture queue item local; this test exercises mutation guards,
    // not background run dispatch.
    conversationRepo.setQueuePaused(
      conversation.conversation_id,
      true,
      "manual_resume_required",
    );
    const queued = queueRepo.enqueue({
      id: "qi_01956789-0000-7000-8000-000000000201",
      conversation_id: conversation.conversation_id,
      operation_id: "op_01956789-0000-7000-8000-000000000201",
      client_request_id: "rq_01956789-0000-7000-8000-000000000201",
      state: "queued",
      payload_text: "Queued before deletion",
    });
    const originalTitle = fakeHermes.getSession("ses_test_1")?.title;
    const originalSessionCount = fakeHermes.sessions.size;

    for (const deleteState of ["pending", "failed"] as const) {
      conversationRepo.setDeleteState(
        conversation.conversation_id,
        deleteState,
        deleteState === "failed" ? "HERMES_UNAVAILABLE" : null,
      );

      const expectDeleteConflict = async (
        method: "PUT" | "PATCH" | "POST",
        url: string,
        payload: Record<string, unknown>,
      ) => {
        const response = await app!.inject({ method, url, payload });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error: { code: "STATE_CONFLICT" },
        });
      };

      await expectDeleteConflict(
        "PUT",
        `/api/v1/conversations/${conversation.conversation_id}/draft`,
        { content: "Must not be saved", expected_revision: 0 },
      );
      await expectDeleteConflict(
        "PATCH",
        `/api/v1/conversations/${conversation.conversation_id}/local-metadata`,
        { tags: ["must-not-change"], expected_revision: 0 },
      );
      await expectDeleteConflict(
        "PATCH",
        `/api/v1/conversations/${conversation.conversation_id}/hermes-metadata`,
        { field: "title", value: "Must not reach Hermes" },
      );
      await expectDeleteConflict(
        "POST",
        `/api/v1/conversations/${conversation.conversation_id}/fork`,
        { title: "Must not fork" },
      );
      await expectDeleteConflict(
        "POST",
        `/api/v1/conversations/${conversation.conversation_id}/reset`,
        { title: "Must not reset" },
      );
      await expectDeleteConflict("PATCH", `/api/v1/queue-items/${queued.id}`, {
        content: "Must not edit queue",
        expected_revision: 0,
      });

      expect(
        conversationRepo.findById(conversation.conversation_id),
      ).toMatchObject({
        delete_state: deleteState,
        metadata_revision: 0,
        tags_json: "[]",
      });
      expect(
        draftRepo.findByConversationId(conversation.conversation_id),
      ).toMatchObject({ content: "", revision: 0 });
      expect(queueRepo.findById(queued.id)).toMatchObject({
        payload_text: "Queued before deletion",
        revision: 0,
      });
      expect(fakeHermes.getSession("ses_test_1")?.title).toBe(originalTitle);
      expect(fakeHermes.sessions.size).toBe(originalSessionCount);
    }
  });

  it("requires a confirmed delete request with a non-empty mapped Hermes session ID", async () => {
    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/conversations",
    });
    const conversation = (
      listResponse.json() as {
        items: Array<{ conversation_id: string; hermes_session_id: string }>;
      }
    ).items.find((item) => item.hermes_session_id === "ses_test_1")!;

    const missingConfirmation = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.conversation_id}/delete`,
      payload: { expected_hermes_session_id: "ses_test_1" },
    });
    expect(missingConfirmation.statusCode).toBe(400);

    const emptySessionId = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.conversation_id}/delete`,
      payload: { expected_hermes_session_id: "", confirmed: true },
    });
    expect(emptySessionId.statusCode).toBe(400);

    const unconfirmed = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.conversation_id}/delete`,
      payload: { expected_hermes_session_id: "ses_test_1", confirmed: false },
    });
    expect(unconfirmed.statusCode).toBe(503);
    expect(unconfirmed.json()).toMatchObject({
      error: { code: "DELETE_UNCONFIRMED" },
    });
    expect(fakeHermes.getSession("ses_test_1")).not.toBeNull();
    expect(
      conversationRepo.findById(conversation.conversation_id)?.delete_state,
    ).toBe("none");
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
    expect(
      leaseRepo.acquire(
        "conversation",
        conversation.conversation_id,
        "test-owner",
        "test-conversation-lease",
        60_000,
      ),
    ).toBe(true);
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
    expect(
      leaseRepo.findByScope("conversation", conversation.conversation_id),
    ).toBeNull();
    expect(fakeHermes.getSession("ses_test_1")).toBeNull();
  });

  it("cleans the local projection when Hermes already deleted the session", async () => {
    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/conversations",
    });
    const conversation = (
      listResponse.json() as {
        items: Array<{ conversation_id: string; hermes_session_id: string }>;
      }
    ).items.find((item) => item.hermes_session_id === "ses_test_1")!;

    fakeHermes.sessions.delete("ses_test_1");
    const deleted = await app!.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.conversation_id}/delete`,
      payload: { expected_hermes_session_id: "ses_test_1", confirmed: true },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      conversation_id: conversation.conversation_id,
      hermes_deleted: true,
      local_cleaned: true,
    });
    expect(conversationRepo.findById(conversation.conversation_id)).toBeNull();
  });
});
