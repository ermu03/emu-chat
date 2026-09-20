import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { buildServer } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/config.js";
import { runMigrations } from "../../src/server/db/migrate.js";

describe("Hermes configuration boundary", () => {
  let app: FastifyInstance | null = null;
  let db: Database.Database | null = null;

  beforeEach(async () => {
    db = new Database(":memory:");
    runMigrations(db);
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: "/tmp/emu-chat-test",
      sqliteDbPath: ":memory:",
      hermesBaseUrl: "http://127.0.0.1:1",
      hermesApiKey: "",
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
  });

  it("reports config_error without a Hermes probe and rejects Hermes mutations", async () => {
    const status = await app!.inject({ method: "GET", url: "/api/v1/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: "config_error",
      hermes_version: null,
      missing_capabilities: [],
      suggested_action: "check_server_configuration",
    });

    const create = await app!.inject({
      method: "POST",
      url: "/api/v1/conversations",
      payload: { title: "Must not reach Hermes" },
    });
    expect(create.statusCode).toBe(502);
    expect(create.json()).toMatchObject({
      error: { code: "HERMES_AUTH_FAILED", retryable: false, action: "none" },
    });
  });
});
