import type Database from "better-sqlite3";
import type { HermesMessageItem } from "../../shared/hermes-schemas.js";
import type { HermesAdapter } from "../hermes/adapter.js";
import { logger } from "../logging.js";
import { MediaClient } from "./client.js";
import { parseMediaRunInput } from "./manifest.js";
import { AttachmentRefSchema } from "../../shared/media-schemas.js";
import { withImmediateTransaction } from "../db/transaction.js";
import {
  mediaScopeState,
  requireMediaScope,
  MediaScopeDeferredError,
  MediaScopeDeletedError,
} from "./scope-state.js";

type BranchRow = {
  target_scope_id: string;
  source_scope_id: string;
  source_session_id: string;
  target_session_id: string;
  copied_message_count: number;
};

/** Reconstructs branch image ownership from Hermes' copied transcript order. */
export class MediaBranchService {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private readonly flights = new Map<
    string,
    Promise<"done" | "deferred" | "deleted">
  >();
  private stopped = false;

  constructor(
    private readonly db: Database.Database,
    private readonly hermes: HermesAdapter,
    private readonly client: MediaClient,
  ) {}

  record(
    sourceScopeId: string,
    sourceSessionId: string,
    targetScopeId: string,
    targetSessionId: string,
    copiedMessageCount: number,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO media_branch_pending
      (target_scope_id,source_scope_id,source_session_id,target_session_id,
       copied_message_count,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',?,?)
      ON CONFLICT(target_scope_id) DO NOTHING`,
      )
      .run(
        targetScopeId,
        sourceScopeId,
        sourceSessionId,
        targetSessionId,
        copiedMessageCount,
        now,
        now,
      );
  }

  hasPendingSource(sourceScopeId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM media_branch_pending
      WHERE source_scope_id=? AND status='pending' LIMIT 1`,
        )
        .get(sourceScopeId),
    );
  }

  start(): void {
    if (this.timer || !this.client.isConfigured()) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 10_000);
    this.timer.unref();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
    await Promise.allSettled(this.flights.values());
  }

  wake(): void {
    if (
      this.stopped ||
      !this.client.isConfigured() ||
      this.active ||
      !this.db.open
    )
      return;
    this.active = this.processPending().finally(() => {
      this.active = null;
    });
  }

  syncOne(targetScopeId: string): Promise<"done" | "deferred" | "deleted"> {
    const existing = this.flights.get(targetScopeId);
    if (existing) return existing;
    const flight = this.syncTarget(targetScopeId).finally(() =>
      this.flights.delete(targetScopeId),
    );
    this.flights.set(targetScopeId, flight);
    return flight;
  }

  private async syncTarget(
    targetScopeId: string,
  ): Promise<"done" | "deferred" | "deleted"> {
    const row = this.db
      .prepare(
        `SELECT target_scope_id,source_scope_id,source_session_id,target_session_id,
          copied_message_count
      FROM media_branch_pending WHERE target_scope_id=? AND status='pending'`,
      )
      .get(targetScopeId) as BranchRow | undefined;
    if (!row)
      return mediaScopeState(this.db, targetScopeId) === "deleted"
        ? "deleted"
        : "done";
    try {
      await this.sync(row);
      return "done";
    } catch (error) {
      if (
        error instanceof MediaScopeDeletedError ||
        mediaScopeState(this.db, targetScopeId) === "deleted"
      )
        return "deleted";
      this.db
        .prepare(
          `UPDATE media_branch_pending SET last_error=?,updated_at=?,next_attempt_at=?
        WHERE target_scope_id=? AND status='pending'`,
        )
        .run(
          error instanceof Error ? error.name : "unknown",
          new Date().toISOString(),
          new Date(Date.now() + 10_000).toISOString(),
          targetScopeId,
        );
      if (
        error instanceof MediaScopeDeferredError ||
        mediaScopeState(this.db, targetScopeId) === "deferred"
      )
        return "deferred";
      throw error;
    }
  }

  private async processPending(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT target_scope_id FROM media_branch_pending
      WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 10`,
      )
      .all(new Date().toISOString()) as { target_scope_id: string }[];
    for (const row of rows) {
      try {
        await this.syncOne(row.target_scope_id);
      } catch (error) {
        logger.warn("Media branch mapping deferred", {
          details: {
            errorName: error instanceof Error ? error.name : "unknown",
          },
        });
      }
    }
  }

  private async transcript(
    sessionId: string,
    maximum: number,
    row: BranchRow,
  ): Promise<HermesMessageItem[]> {
    const result: HermesMessageItem[] = [];
    let offset = 0;
    while (offset < maximum) {
      const page = await this.call(row, () =>
        this.hermes.getSessionMessages(sessionId, {
          order: "oldest",
          offset,
          limit: Math.min(500, maximum - offset),
        }),
      );
      result.push(...page.messages);
      if (!page.messages.length) break;
      offset += page.messages.length;
    }
    if (result.length !== maximum)
      throw new Error("Copied Hermes transcript count changed");
    return result;
  }

  private static sameCopy(
    source: HermesMessageItem,
    target: HermesMessageItem,
  ): boolean {
    return (
      source.role === target.role &&
      source.content === target.content &&
      (source.tool_call_id ?? null) === (target.tool_call_id ?? null) &&
      (source.tool_name ?? null) === (target.tool_name ?? null) &&
      JSON.stringify(source.tool_calls ?? null) ===
        JSON.stringify(target.tool_calls ?? null)
    );
  }

  private async sync(row: BranchRow): Promise<void> {
    requireMediaScope(this.db, row.target_scope_id);
    const source = this.db
      .prepare("SELECT 1 FROM conversations WHERE id=?")
      .get(row.source_scope_id);
    if (!source)
      throw new Error("Source conversation disappeared before branch mapping");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM media_branch_pending WHERE target_scope_id=? AND status='pending'",
        )
        .get(row.source_scope_id)
    )
      throw new MediaScopeDeferredError(
        "Direct source branch mapping has not completed",
      );
    if (row.copied_message_count < 0 || row.copied_message_count > 100_000)
      throw new Error("Copied transcript is outside the supported bound");

    const [sourceResult, targetResult] = await Promise.allSettled([
      this.transcript(row.source_session_id, row.copied_message_count, row),
      this.transcript(row.target_session_id, row.copied_message_count, row),
    ]);
    if (sourceResult.status === "rejected") throw sourceResult.reason;
    if (targetResult.status === "rejected") throw targetResult.reason;
    const sourceRows = sourceResult.value;
    const targetRows = targetResult.value;
    for (let index = 0; index < sourceRows.length; index++) {
      if (!MediaBranchService.sameCopy(sourceRows[index]!, targetRows[index]!))
        throw new Error("Branch transcript differs from the source copy");
    }
    await this.call(row, () =>
      this.client.registerSession(row.target_scope_id, row.target_session_id),
    );
    const mapping: Array<{
      targetId: number;
      ids: string[];
      operationId: string | null;
    }> = [];
    for (let index = 0; index < sourceRows.length; index++) {
      const original = sourceRows[index]!;
      const copied = targetRows[index]!;
      let ids: string[] = [];
      let operationId: string | null = null;
      const inherited = this.db
        .prepare(
          `SELECT asset_ids_json,source_operation_id FROM media_branch_messages
        WHERE target_scope_id=? AND target_message_id=?`,
        )
        .get(row.source_scope_id, original.id) as
        | { asset_ids_json: string; source_operation_id: string | null }
        | undefined;
      if (inherited) {
        ids = AttachmentRefSchema.shape.asset_id
          .array()
          .min(1)
          .max(100)
          .parse(JSON.parse(inherited.asset_ids_json));
        operationId = inherited.source_operation_id;
        if (original.role === "user") {
          const manifest = parseMediaRunInput(original.content);
          if (
            !manifest ||
            manifest.operationId !== operationId ||
            JSON.stringify(manifest.assetIds) !== JSON.stringify(ids)
          )
            throw new Error(
              "Inherited submission differs from verified message mapping",
            );
        } else if (
          original.role !== "tool" ||
          original.tool_name !== "image_generate" ||
          !original.tool_call_id ||
          operationId !== null
        )
          throw new Error(
            "Inherited image mapping is not a copied image message",
          );
      } else if (original.role === "user") {
        const manifest = parseMediaRunInput(original.content);
        if (
          manifest &&
          manifest.scopeId === row.source_scope_id &&
          manifest.sessionId === original.session_id
        ) {
          const bound = await this.call(row, () =>
            this.client.getSubmission(
              row.source_scope_id,
              manifest.operationId,
            ),
          );
          if (
            bound.scope_id !== row.source_scope_id ||
            bound.operation_id !== manifest.operationId ||
            bound.session_id !== manifest.sessionId ||
            bound.run_input_sha256 !== manifest.runInputSha256 ||
            bound.user_text_sha256 !== manifest.userTextSha256 ||
            JSON.stringify(bound.asset_ids) !==
              JSON.stringify(manifest.assetIds)
          )
            throw new Error("Source image submission identity differs");
          ids = manifest.assetIds;
          operationId = manifest.operationId;
        }
      } else if (
        original.role === "tool" &&
        original.tool_name === "image_generate" &&
        original.tool_call_id
      ) {
        const toolCallId = original.tool_call_id;
        let listed = await this.call(row, () =>
          this.client.listAssets(row.source_scope_id, {
            tool_call_id: toolCallId,
            limit: 100,
          }),
        );
        if (!listed.data.length && this.successfulImageTool(original.content)) {
          await this.call(row, () =>
            this.client.reconcile(row.source_scope_id, [original.session_id]),
          );
          listed = await this.call(row, () =>
            this.client.listAssets(row.source_scope_id, {
              tool_call_id: toolCallId,
              limit: 100,
            }),
          );
          if (!listed.data.length)
            throw new Error("Image capture has not been indexed yet");
        }
        ids = listed.data
          .filter(
            (asset) =>
              asset.source.kind === "tool" &&
              asset.source.session_id === original.session_id &&
              asset.source.tool_call_id === original.tool_call_id,
          )
          .map((asset) => asset.asset_id);
        if (!ids.length && this.successfulImageTool(original.content))
          throw new Error("Image capture has no verified source assets yet");
      }
      if (!ids.length) continue;
      for (const id of ids) {
        const granted = await this.call(row, () =>
          this.client.grantAsset(row.target_scope_id, id, row.source_scope_id),
        );
        if (granted.scope_id !== row.target_scope_id || granted.asset_id !== id)
          throw new Error("Granted image identity differs from copied message");
      }
      for (let part = 0; part < ids.length; part += 4) {
        await this.call(row, () =>
          this.client.putReference(
            row.target_scope_id,
            `ref_branch_${copied.id}_${Math.floor(part / 4)}`,
            {
              version: 1,
              kind: "branch",
              revision: 0,
              session_id: row.target_session_id,
              asset_ids: ids.slice(part, part + 4),
            },
          ),
        );
      }
      mapping.push({ targetId: copied.id, ids, operationId });
    }
    withImmediateTransaction(this.db, () => {
      requireMediaScope(this.db, row.target_scope_id);
      for (const item of mapping) {
        this.db
          .prepare(
            `INSERT INTO media_branch_messages
          (target_scope_id,target_message_id,asset_ids_json,source_operation_id)
          VALUES (?,?,?,?) ON CONFLICT(target_scope_id,target_message_id) DO UPDATE SET
          asset_ids_json=excluded.asset_ids_json,source_operation_id=excluded.source_operation_id`,
          )
          .run(
            row.target_scope_id,
            item.targetId,
            JSON.stringify(item.ids),
            item.operationId,
          );
      }
      this.db
        .prepare(
          `UPDATE media_branch_pending SET status='done',last_error=NULL,updated_at=?
        WHERE target_scope_id=? AND status='pending'`,
        )
        .run(new Date().toISOString(), row.target_scope_id);
    });
  }

  private async call<T>(row: BranchRow, action: () => Promise<T>): Promise<T> {
    requireMediaScope(this.db, row.target_scope_id);
    const result = await action();
    requireMediaScope(this.db, row.target_scope_id);
    return result;
  }

  private successfulImageTool(content: string): boolean {
    try {
      const value = JSON.parse(content) as Record<string, unknown>;
      return (
        value.success === true &&
        (typeof value.image === "string" ||
          typeof value.host_image === "string" ||
          Array.isArray(value.images))
      );
    } catch {
      return false;
    }
  }
}
