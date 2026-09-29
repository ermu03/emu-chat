import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { logger } from "../logging.js";
import {
  MediaClient,
  MediaConflictError,
  MediaUnavailableError,
} from "./client.js";

type Kind =
  | "register"
  | "reference_put"
  | "reference_delete"
  | "submission_bind"
  | "scope_delete"
  | "grant"
  | "history_handoff"
  | "orphan_release";

export function hasLocalMediaReference(
  db: Database.Database,
  scopeId: string,
  assetId: string,
): boolean {
  if (
    db
      .prepare(
        `SELECT 1 FROM media_branch_pending WHERE source_scope_id=?
    AND status='pending' LIMIT 1`,
      )
      .get(scopeId)
  )
    return true;
  return Boolean(
    db
      .prepare(
        `
    SELECT 1 FROM drafts d,json_each(d.attachments_json) j
      WHERE d.conversation_id=? AND j.value IS NOT NULL
        AND json_extract(j.value,'$.asset_id')=?
    UNION ALL
    SELECT 1 FROM queue_items q,json_each(q.payload_attachments_json) j
      WHERE q.conversation_id=? AND json_extract(j.value,'$.asset_id')=?
    UNION ALL
    SELECT 1 FROM media_branch_messages m,json_each(m.asset_ids_json) j
      WHERE m.target_scope_id=? AND j.value=?
    UNION ALL
    SELECT 1 FROM media_outbox o,json_each(o.payload_json,'$.asset_ids') j
      WHERE o.scope_id=? AND o.kind='history_handoff' AND j.value=?
    LIMIT 1
  `,
      )
      .get(
        scopeId,
        assetId,
        scopeId,
        assetId,
        scopeId,
        assetId,
        scopeId,
        assetId,
      ),
  );
}

interface OutboxRow {
  id: string;
  scope_id: string;
  kind: Kind;
  payload_json: string;
  status: "pending" | "done" | "review";
  attempt_count: number;
}

export function enqueueMediaSync(
  db: Database.Database,
  id: string,
  scopeId: string,
  kind: Kind,
  payload: unknown,
): void {
  const now = new Date().toISOString();
  const encoded = JSON.stringify(payload);
  db.prepare(
    `
    INSERT INTO media_outbox(id,scope_id,kind,payload_json,status,attempt_count,
                             next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,?,'pending',0,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json=excluded.payload_json,
      status=CASE WHEN media_outbox.payload_json=excluded.payload_json
                   AND media_outbox.status='done' THEN 'done' ELSE 'pending' END,
      attempt_count=CASE WHEN media_outbox.payload_json=excluded.payload_json
                         THEN media_outbox.attempt_count ELSE 0 END,
      next_attempt_at=excluded.next_attempt_at,
      last_error_code=NULL,updated_at=excluded.updated_at
  `,
  ).run(id, scopeId, kind, encoded, now, now, now);
}

export function queueMediaRegistration(
  db: Database.Database,
  scopeId: string,
  sessionId: string,
): void {
  const suffix = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  enqueueMediaSync(db, `register_${scopeId}_${suffix}`, scopeId, "register", {
    session_id: sessionId,
  });
}

export class MediaSyncWorker {
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private activePromise: Promise<void> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly client: MediaClient,
  ) {}

  start(): void {
    if (this.timer || !this.client.isConfigured()) return;
    this.timer = setInterval(() => this.wake(), 2000);
    this.wake();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activePromise;
  }

  wake(): void {
    if (this.client.isConfigured() && !this.activePromise) {
      this.activePromise = this.tick().finally(() => {
        this.activePromise = null;
      });
    }
  }

  enqueueRegistration(scopeId: string, sessionId: string): void {
    if (!this.client.isConfigured()) return;
    queueMediaRegistration(this.db, scopeId, sessionId);
    this.wake();
  }

  private async tick(): Promise<void> {
    if (this.active || !this.db.open) return;
    this.active = true;
    try {
      for (let index = 0; index < 20; index++) {
        const task = this.db
          .prepare(
            `
          SELECT * FROM media_outbox WHERE status='pending' AND next_attempt_at<=?
          ORDER BY created_at,id LIMIT 1
        `,
          )
          .get(new Date().toISOString()) as OutboxRow | undefined;
        if (!task) break;
        const conversation = this.db
          .prepare("SELECT delete_state FROM conversations WHERE id=?")
          .get(task.scope_id) as { delete_state: string } | undefined;
        if (
          task.kind !== "scope_delete" &&
          (!conversation || conversation.delete_state !== "none")
        ) {
          this.markDone(task);
          continue;
        }
        try {
          await this.apply(task);
          this.markDone(task);
        } catch (error) {
          this.markFailed(task, error);
        }
      }
    } catch (error) {
      logger.error("Media sync worker failed", {
        details: { name: error instanceof Error ? error.name : "unknown" },
      });
    } finally {
      this.active = false;
    }
  }

  private async apply(task: OutboxRow): Promise<void> {
    const payload = JSON.parse(task.payload_json) as Record<string, unknown>;
    switch (task.kind) {
      case "register":
        await this.client.registerSession(
          task.scope_id,
          String(payload["session_id"]),
        );
        break;
      case "reference_put":
        await this.client.registerSession(
          task.scope_id,
          String(payload["session_id"]),
        );
        await this.client.putReference(
          task.scope_id,
          String(payload["reference_id"]),
          {
            version: 1,
            kind: payload["kind"] as
              "draft" | "queue" | "history" | "branch" | "upload",
            revision: Number(payload["revision"]),
            session_id: String(payload["session_id"]),
            asset_ids: payload["asset_ids"] as string[],
          },
        );
        break;
      case "reference_delete":
        await this.client.deleteReference(
          task.scope_id,
          String(payload["reference_id"]),
        );
        break;
      case "scope_delete":
        await this.client.deleteScope(task.scope_id);
        break;
      case "submission_bind":
        await this.client.bindSubmission(
          task.scope_id,
          String(payload["operation_id"]),
          {
            version: 1,
            session_id: String(payload["session_id"]),
            asset_ids: payload["asset_ids"] as string[],
            user_text_sha256: String(payload["user_text_sha256"]),
            run_input_sha256: String(payload["run_input_sha256"]),
          },
        );
        break;
      case "grant":
        await this.client.grantAsset(
          task.scope_id,
          String(payload["asset_id"]),
          String(payload["source_scope_id"]),
        );
        break;
      case "history_handoff":
        await this.client.registerSession(
          task.scope_id,
          String(payload["session_id"]),
        );
        await this.client.putReference(
          task.scope_id,
          `ref_history_${String(payload["operation_id"])}`,
          {
            version: 1,
            kind: "history",
            revision: 0,
            session_id: String(payload["session_id"]),
            asset_ids: payload["asset_ids"] as string[],
          },
        );
        if (typeof payload["queue_reference_id"] === "string")
          await this.client.deleteReference(
            task.scope_id,
            payload["queue_reference_id"],
          );
        break;
      case "orphan_release": {
        const assetId = String(payload["asset_id"]);
        if (hasLocalMediaReference(this.db, task.scope_id, assetId)) break;
        await this.client.releaseOrphan(task.scope_id, assetId);
        break;
      }
    }
  }

  private markDone(task: OutboxRow): void {
    this.db
      .prepare(
        `UPDATE media_outbox SET status='done',updated_at=?
      WHERE id=? AND status='pending' AND payload_json=?`,
      )
      .run(new Date().toISOString(), task.id, task.payload_json);
  }

  private markFailed(task: OutboxRow, error: unknown): void {
    const current = this.db
      .prepare("SELECT payload_json FROM media_outbox WHERE id=?")
      .get(task.id) as { payload_json: string } | undefined;
    if (!current || current.payload_json !== task.payload_json) return;
    const retryable =
      error instanceof MediaUnavailableError ||
      (task.kind === "orphan_release" && error instanceof MediaConflictError);
    const review = !retryable;
    const attempt = task.attempt_count + 1;
    const next = new Date(
      Date.now() +
        (task.kind === "orphan_release"
          ? 3_600_000
          : Math.min(300_000, 2000 * 2 ** Math.min(attempt, 7))),
    );
    this.db
      .prepare(
        `UPDATE media_outbox SET status=?,attempt_count=?,last_error_code=?,
      next_attempt_at=?,updated_at=? WHERE id=? AND status='pending' AND payload_json=?`,
      )
      .run(
        review ? "review" : "pending",
        attempt,
        error instanceof Error ? error.name : "unknown",
        next.toISOString(),
        new Date().toISOString(),
        task.id,
        task.payload_json,
      );
    logger.warn("Media sync task deferred", {
      details: {
        kind: task.kind,
        errorName: error instanceof Error ? error.name : "unknown",
      },
    });
  }
}
