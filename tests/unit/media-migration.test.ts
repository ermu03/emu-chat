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
    for (const file of [
      "0002_media.sql",
      "0003_conversation_list_order.sql",
      "0004_media_submission_proofs.sql",
    ])
      writeFileSync(
        path.join(directory, file),
        readFileSync(path.resolve("migrations", file)),
      );
    expect(runMigrations(db, directory)).toEqual([
      "0002_media.sql",
      "0003_conversation_list_order.sql",
      "0004_media_submission_proofs.sql",
    ]);
    // Older versions marked descendants done while skipping inherited images.
    db.prepare(
      `INSERT INTO conversations (id,hermes_profile,hermes_session_id,created_at,updated_at)
      VALUES ('cv_child','default','ses_child',?,?),('cv_descendant','default','ses_descendant',?,?),('cv_unrecoverable','default','ses_unrecoverable',?,?)`,
    ).run(now, now, now, now, now, now);
    db.prepare(
      `INSERT INTO media_branch_messages (target_scope_id,target_message_id,asset_ids_json,source_operation_id)
      VALUES ('cv_existing',11,'["asset_input"]','op_original')`,
    ).run();
    db.prepare(
      `INSERT INTO media_branch_pending (target_scope_id,source_scope_id,source_session_id,target_session_id,copied_message_count,status,created_at,updated_at)
      VALUES ('cv_child','cv_existing','ses_existing','ses_child',1,'done',?,?),
        ('cv_descendant','cv_child','ses_child','ses_descendant',1,'done',?,?),
        ('cv_unrecoverable','cv_deleted','ses_deleted','ses_unrecoverable',1,'done',?,?)`,
    ).run(now, now, now, now, now, now);
    expect(runMigrations(db)).toEqual(["0005_media_branch_retry.sql"]);
    expect(
      db
        .prepare(
          "SELECT target_scope_id,status,next_attempt_at FROM media_branch_pending ORDER BY target_scope_id",
        )
        .all(),
    ).toEqual([
      { target_scope_id: "cv_child", status: "pending", next_attempt_at: "" },
      {
        target_scope_id: "cv_descendant",
        status: "pending",
        next_attempt_at: "",
      },
      {
        target_scope_id: "cv_unrecoverable",
        status: "done",
        next_attempt_at: "",
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT asset_ids_json,source_operation_id FROM media_branch_messages",
        )
        .get(),
    ).toEqual({
      asset_ids_json: '["asset_input"]',
      source_operation_id: "op_original",
    });
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
