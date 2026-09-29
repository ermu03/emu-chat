import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { buildServer } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/config.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";

const digest = "a".repeat(64);
const image = Buffer.from("fake-image-bytes");

it("keeps an uploaded attachment through draft CAS, one Run admission and history handoff", async () => {
  const hermes = new FakeHermesServer();
  const baseUrl = await hermes.start();
  const db = new Database(":memory:");
  runMigrations(db);
  const rawFetch = globalThis.fetch;
  const bound = new Map<string, Record<string, unknown>>();
  const pluginCalls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.includes("/v1/emu-media/")) return rawFetch(input, init);
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
    if (path.endsWith("/uploads")) return Response.json(asset, { status: 201 });
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
        bound.set(operationId, body);
        return Response.json({ protocol_version: 1 });
      }
      return Response.json({
        protocol_version: 1,
        scope_id: scope,
        operation_id: operationId,
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
  const app = buildServer(config, { db });
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
    const deadline = Date.now() + 4000;
    while (hermes.admissionRequests < 1 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hermes.admissionRequests).toBe(1);
    const sessionId = (
      db
        .prepare("SELECT hermes_session_id FROM conversations WHERE id=?")
        .get(scope) as { hermes_session_id: string }
    ).hermes_session_id;
    const messages = hermes.getMessages(sessionId) ?? [];
    expect(
      messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes('"asset_ids":["asset_upload"]'),
      ),
    ).toBe(true);
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
  } finally {
    await app.close();
    if (db.open) db.close();
    await hermes.close();
    vi.restoreAllMocks();
  }
});

afterEach(() => vi.restoreAllMocks());
