import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { buildServer } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/config.js";
import { DataRetentionService } from "../../src/server/services/data-retention-service.js";
import { QueueRepository } from "../../src/server/db/repositories/queue.repository.js";
import { parseMediaRunInput } from "../../src/server/media/manifest.js";
import { hasLocalMediaReference } from "../../src/server/media/sync.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";

const digest = "a".repeat(64);
const image = Buffer.from("fake-image-bytes");

it("keeps an uploaded attachment through draft CAS, lost-admission restart, text cleanup, offline history and descendant branches", async () => {
  const hermes = new FakeHermesServer();
  const baseUrl = await hermes.start();
  const db = new Database(":memory:");
  runMigrations(db);
  const rawFetch = globalThis.fetch;
  const bound = new Map<string, Record<string, unknown>>();
  const pluginCalls: string[] = [];
  const permissions = new Set<string>();
  const tombstones = new Set<string>();
  let pluginOffline = false;
  let wrongOperation = false;
  const bindings: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.includes("/v1/emu-media/")) return rawFetch(input, init);
    if (pluginOffline) throw new Error("plugin offline");
    const path = new URL(url).pathname;
    pluginCalls.push(`${init?.method ?? "GET"} ${path}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer media-test-key",
    );
    const scope = path.match(/\/scopes\/(cv_[^/]+)/)?.[1] ?? "";
    const asset = {
      protocol_version: 1,
      asset_id: "asset_upload",
      scope_id: scope,
      status: "ready",
      source: { kind: "upload", upload_id: "upload_test" },
      mime_type: "image/png",
      byte_size: image.length,
      width: 2,
      height: 2,
      sha256: digest,
      file_name: "test.png",
    };
    if (path.endsWith("/capabilities"))
      return Response.json({
        protocol_version: 1,
        limits: {
          max_attachments: 4,
          max_upload_bytes: 8388608,
          max_capture_bytes: 33554432,
          max_pixels: 32000000,
          max_side_pixels: 16384,
          max_storage_bytes: 5368709120,
          mime_types: ["image/png", "image/jpeg", "image/webp"],
        },
        vision: {
          status: "available",
          reason: null,
          input_bridge: "local_file",
        },
        generation: { status: "unknown", reason: null },
        editing: {
          status: "unsupported",
          reason: "test",
          input_bridge: null,
          max_reference_images: 0,
        },
      });
    if (tombstones.has(scope))
      return Response.json({ error: "deleted" }, { status: 410 });
    if (path.endsWith(`/scopes/${scope}`) && init?.method === "DELETE") {
      permissions.delete(scope);
      tombstones.add(scope);
      return Response.json({ protocol_version: 1 });
    }
    if (path.endsWith("/grants/asset_upload")) {
      const body = JSON.parse(String(init?.body)) as {
        source_scope_id: string;
      };
      expect(permissions.has(body.source_scope_id)).toBe(true);
      permissions.add(scope);
      return Response.json(asset);
    }
    if (path.endsWith("/uploads")) {
      permissions.add(scope);
      return Response.json(asset, { status: 201 });
    }
    if (path.includes("/assets/") && !permissions.has(scope))
      return Response.json({ error: "forbidden" }, { status: 404 });
    if (path.endsWith("/assets/asset_upload/content"))
      return new Response(image, {
        headers: { "content-type": "image/png" },
      });
    if (path.endsWith("/assets/asset_upload")) return Response.json(asset);
    if (path.endsWith("/assets"))
      return Response.json({
        protocol_version: 1,
        data: [asset],
        next_cursor: null,
      });
    if (path.includes("/submissions/")) {
      const operationId = path.split("/").at(-1)!;
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bindings.push(body);
        bound.set(operationId, body);
        return Response.json({ protocol_version: 1 });
      }
      return Response.json({
        protocol_version: 1,
        scope_id: scope,
        operation_id: wrongOperation ? "op_wrong" : operationId,
        ...bound.get(operationId),
      });
    }
    return Response.json({ protocol_version: 1 });
  });
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: "/tmp/emu-chat-media-test",
    sqliteDbPath: ":memory:",
    hermesBaseUrl: baseUrl,
    hermesApiKey: "test-token",
    mediaApiKey: "media-test-key",
    logLevel: "error",
    isProduction: false,
  };
  let app = buildServer(config, { db });
  try {
    await app.ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      payload: { title: "Image integration" },
    });
    expect(created.statusCode).toBe(201);
    const scope = (created.json() as { conversation_id: string })
      .conversation_id;
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${scope}/media/uploads`,
      payload: image,
      headers: {
        "content-type": "image/png",
        "idempotency-key": "upload_test",
        "x-file-name": "test.png",
      },
    });
    expect(upload.statusCode).toBe(201);
    const ref = { asset_id: "asset_upload", sha256: digest };
    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/conversations/${scope}/draft`,
      payload: { content: "", attachments: [ref], expected_revision: 0 },
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (saved.json() as { attachments: unknown[] }).attachments,
    ).toHaveLength(1);
    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/conversations/${scope}/draft`,
      payload: { content: "stale", attachments: [], expected_revision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    hermes.loseNextRunAdmissionResponse = true;
    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${scope}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000777",
        expected_draft_revision: 1,
      },
    });
    expect(sent.statusCode).toBe(202);
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${scope}/messages`,
      payload: {
        client_request_id: "00000000-0000-4000-8000-000000000777",
        expected_draft_revision: 999,
      },
    });
    expect(replay.json()).toMatchObject({ replayed: true });
    const itemId = (sent.json() as { queue_item: { id: string } }).queue_item
      .id;
    const queue = new QueueRepository(db);
    const waitFor = async (check: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!check() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(check()).toBe(true);
    };
    await waitFor(() => queue.findById(itemId)?.last_error_code !== null);
    expect(hermes.admissionRequests).toBe(1);
    const frozen = queue.findById(itemId)!;
    expect(frozen.state).toBe("dispatching");
    expect(frozen.payload_run_input).toContain("<emu-media-input-v1>");
    new DataRetentionService(db, queue).runBatch(
      new Date(Date.now() + 100 * 86400_000),
    );
    expect(queue.findById(itemId)?.payload_run_input).toBe(
      frozen.payload_run_input,
    );
    await app.close();
    db.prepare("UPDATE queue_items SET updated_at=? WHERE id=?").run(
      new Date(Date.now() - 60_000).toISOString(),
      itemId,
    );
    app = buildServer(config, { db });
    await app.ready();
    await waitFor(() => queue.findById(itemId)?.state === "done");
    expect(hermes.admissionRequests).toBe(2);
    expect(bindings).toHaveLength(2);
    expect(bindings[1]).toEqual(bindings[0]);
    expect(queue.findById(itemId)).toMatchObject({
      payload_text: null,
      payload_run_input: null,
    });

    const sessionId = (
      db
        .prepare("SELECT hermes_session_id FROM conversations WHERE id=?")
        .get(scope) as { hermes_session_id: string }
    ).hermes_session_id;
    const messages = hermes.getMessages(sessionId) ?? [];
    const submitted = messages.filter((message) => message.role === "user");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.content).toBe(frozen.payload_run_input);
    const parsed = parseMediaRunInput(submitted[0]!.content)!;
    expect(
      db
        .prepare(
          "SELECT user_text_sha256,run_input_sha256 FROM media_submission_proofs WHERE operation_id=?",
        )
        .get(parsed.operationId),
    ).toEqual({
      user_text_sha256: parsed.userTextSha256,
      run_input_sha256: parsed.runInputSha256,
    });
    expect(pluginCalls.some((call) => call.includes("/submissions/"))).toBe(
      true,
    );
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${scope}/messages`,
    });
    expect(history.statusCode).toBe(200);
    const body = history.json() as {
      items: Array<{
        role: string;
        content: string;
        attachments: Array<{ asset_id: string }>;
      }>;
    };
    expect(
      body.items.some(
        (message) =>
          message.role === "user" &&
          message.attachments?.some(
            (attachment) => attachment.asset_id === "asset_upload",
          ) &&
          !message.content.includes("<emu-media-input-v1>"),
      ),
    ).toBe(true);
    // Control retention cannot take the local history proof or picture ownership.
    new DataRetentionService(db, queue).runBatch(
      new Date(Date.now() + 8 * 86400_000),
    );
    expect(queue.findById(itemId)).toBeNull();
    expect(hasLocalMediaReference(db, scope, "asset_upload")).toBe(true);
    const afterControls = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${scope}/messages`,
    });
    expect(afterControls.statusCode).toBe(200);
    const handoff = db
      .prepare("SELECT payload_json FROM media_outbox WHERE id=?")
      .get(`history_${scope}_${parsed.operationId}`) as {
      payload_json: string;
    };
    expect(JSON.parse(handoff.payload_json)).toMatchObject({
      queue_reference_id: `ref_queue_${itemId}`,
    });
    // Legacy history without local proof must obtain an exact plugin binding.
    db.prepare("DELETE FROM media_submission_proofs WHERE operation_id=?").run(
      parsed.operationId,
    );
    wrongOperation = true;
    const unverified = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${scope}/messages`,
    });
    expect(unverified.statusCode).toBe(200);
    expect(unverified.json()).toMatchObject({
      items: [
        { role: "user", content: frozen.payload_run_input },
        { role: "assistant" },
      ],
    });
    expect(
      (unverified.json() as { items: Array<{ attachments?: unknown[] }> })
        .items[0]?.attachments,
    ).toBeUndefined();
    wrongOperation = false;
    const verified = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${scope}/messages`,
    });
    expect(verified.json()).toMatchObject({
      items: [
        {
          role: "user",
          content: "",
          attachments: [{ asset_id: "asset_upload" }],
        },
        { role: "assistant" },
      ],
    });
    expect(
      db
        .prepare(
          "SELECT operation_id FROM media_submission_proofs WHERE operation_id=?",
        )
        .get(parsed.operationId),
    ).toEqual({ operation_id: parsed.operationId });
    pluginOffline = true;
    const offline = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${scope}/messages`,
    });
    expect(offline.statusCode).toBe(200);
    expect(offline.json()).toMatchObject({
      items: [
        {
          role: "user",
          content: "",
          attachments: [{ asset_id: "asset_upload", status: "unavailable" }],
        },
        { role: "assistant" },
      ],
    });
    pluginOffline = false;
    const fork = async (source: string) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${source}/fork`,
        payload: {},
      });
      expect(response.statusCode).toBe(201);
      return (response.json() as { conversation_id: string }).conversation_id;
    };
    const deleteConversation = async (id: string) => {
      const row = db
        .prepare("SELECT hermes_session_id FROM conversations WHERE id=?")
        .get(id) as { hermes_session_id: string };
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${id}/delete`,
        payload: {
          confirmed: true,
          expected_hermes_session_id: row.hermes_session_id,
        },
      });
      expect(response.statusCode).toBe(200);
      await waitFor(() => tombstones.has(id));
    };
    const child = await fork(scope);
    expect(permissions.has(child)).toBe(true);
    await deleteConversation(scope);
    const submissionReads = pluginCalls.filter(
      (call) => call.startsWith("GET ") && call.includes("/submissions/"),
    ).length;
    const grandchild = await fork(child);
    expect(permissions.has(grandchild)).toBe(true);
    expect(
      pluginCalls.filter(
        (call) => call.startsWith("GET ") && call.includes("/submissions/"),
      ).length,
    ).toBe(submissionReads);
    await deleteConversation(child);
    const inheritedHistory = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${grandchild}/messages`,
    });
    expect(inheritedHistory.statusCode).toBe(200);
    expect(inheritedHistory.json()).toMatchObject({
      items: [
        {
          role: "user",
          content: "",
          attachments: [{ asset_id: "asset_upload", status: "ready" }],
        },
        { role: "assistant" },
      ],
    });
    const grandchildSession = db
      .prepare("SELECT hermes_session_id FROM conversations WHERE id=?")
      .get(grandchild) as { hermes_session_id: string };
    const inheritedUser = hermes.getMessages(
      grandchildSession.hermes_session_id,
    )![0]!;
    expect(inheritedUser.id).not.toBe(submitted[0]!.id);
    expect(
      db
        .prepare(
          "SELECT target_message_id,source_operation_id FROM media_branch_messages WHERE target_scope_id=?",
        )
        .get(grandchild),
    ).toEqual({
      target_message_id: inheritedUser.id,
      source_operation_id: parsed.operationId,
    });
  } finally {
    await app.close();
    if (db.open) db.close();
    await hermes.close();
    vi.restoreAllMocks();
  }
});

afterEach(() => vi.restoreAllMocks());
