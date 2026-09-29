import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations } from "../../src/server/db/migrate.js";

it("upgrades an existing text draft and queue without discarding their data", () => {
  const db = new Database(":memory:");
  const directory = mkdtempSync(
    path.join(tmpdir(), "emu-chat-media-migration-"),
  );
  try {
    writeFileSync(
      path.join(directory, "0001_initial.sql"),
      readFileSync(path.resolve("migrations/0001_initial.sql")),
    );
    expect(runMigrations(db, directory)).toEqual(["0001_initial.sql"]);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO conversations
      (id,hermes_profile,hermes_session_id,created_at,updated_at)
      VALUES ('cv_existing','default','ses_existing',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO drafts
      (conversation_id,content,revision,created_at,updated_at)
      VALUES ('cv_existing','saved text',3,?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO queue_items
      (id,conversation_id,operation_id,client_request_id,fifo_seq,state,
       payload_text,payload_sha256,payload_bytes,idempotency_key,created_at,updated_at)
      VALUES ('qi_existing','cv_existing','op_existing','existing-request',1,'queued',
       'queued text',?,11,'ec_existing',?,?)`,
    ).run("b".repeat(64), now, now);
    expect(runMigrations(db)).toEqual(["0002_media.sql"]);
    expect(
      db.prepare("SELECT content,revision,attachments_json FROM drafts").get(),
    ).toEqual({ content: "saved text", revision: 3, attachments_json: "[]" });
    expect(
      db
        .prepare(
          `SELECT payload_text,payload_attachments_json,media_state
      FROM queue_items`,
        )
        .get(),
    ).toEqual({
      payload_text: "queued text",
      payload_attachments_json: "[]",
      media_state: "ready",
    });
    expect(runMigrations(db)).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
