import type Database from "better-sqlite3";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { ConversationRepository } from "../db/repositories/conversation.repository.js";
import { LocalNotFoundError, StateConflictError } from "../domain/errors.js";
import type {
  ConversationEntity,
  QueueItemEntity,
} from "../db/schema-types.js";
import { MediaClient } from "./client.js";
import {
  type MediaAsset,
  type PluginAsset,
  type MediaCapabilities,
} from "../../shared/media-schemas.js";
import type { MessageItem } from "../../shared/api-schemas.js";
import {
  hasSubmissionProof,
  recordSubmissionProof,
  preserveFrozenSubmissionProof,
} from "./submission-proof.js";
import { parseMediaRunInput } from "./manifest.js";
import { enqueueMediaSync, hasLocalMediaReference } from "./sync.js";

const AssetId = z.string().regex(/^asset_[A-Za-z0-9_-]{1,122}$/);

/** Checks local ownership before the private plugin is consulted. */
export class MediaService {
  private readonly reconcileFlights = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Database.Database,
    private readonly conversations: ConversationRepository,
    private readonly client: MediaClient,
  ) {}

  async capabilities(conversationId: string): Promise<MediaCapabilities> {
    this.requireConversation(conversationId);
    return this.client.capabilities();
  }

  async register(conversationId: string, sessionId?: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    await this.client.registerSession(
      conversation.id,
      sessionId ?? conversation.hermes_session_id,
    );
  }

  async upload(
    conversationId: string,
    uploadId: string,
    mime: string,
    fileName: string,
    stream: Readable,
    signal?: AbortSignal,
  ): Promise<MediaAsset> {
    const conversation = this.requireConversation(conversationId);
    await this.register(conversationId);
    const asset = await this.client.upload(
      conversation.id,
      uploadId,
      mime,
      fileName,
      stream,
      signal,
    );
    this.requireConversation(conversationId);
    return this.saveAsset(conversation.id, asset);
  }

  async getAsset(conversationId: string, assetId: string): Promise<MediaAsset> {
    const conversation = this.requireConversation(conversationId);
    AssetId.parse(assetId);
    const asset = await this.client.getAsset(conversation.id, assetId);
    this.requireConversation(conversationId);
    return this.saveAsset(conversation.id, asset);
  }

  async listAssets(
    conversationId: string,
    query: {
      cursor?: string | undefined;
      limit?: number | undefined;
      operation_id?: string | undefined;
      session_id?: string | undefined;
      tool_call_id?: string | undefined;
    } = {},
  ): Promise<{ data: MediaAsset[]; next_cursor: string | null }> {
    const conversation = this.requireConversation(conversationId);
    const response = await this.client.listAssets(conversation.id, query);
    this.requireConversation(conversationId);
    return {
      data: response.data.map((asset) =>
        this.saveAsset(conversation.id, asset),
      ),
      next_cursor: response.next_cursor,
    };
  }

  async getContent(conversationId: string, assetId: string): Promise<Response> {
    const conversation = this.requireConversation(conversationId);
    AssetId.parse(assetId);
    const response = await this.client.getContent(conversation.id, assetId);
    try {
      this.requireConversation(conversationId);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  }

  async retryCapture(conversationId: string, assetId: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    AssetId.parse(assetId);
    await this.client.retryCapture(conversation.id, assetId);
  }

  async reconcile(conversationId: string): Promise<unknown> {
    const existing = this.reconcileFlights.get(conversationId);
    if (existing) return existing;
    const flight = (async () => {
      const conversation = this.requireConversation(conversationId);
      await this.register(conversationId);
      const aliases = this.db
        .prepare(
          `SELECT DISTINCT dispatch_session_id AS id FROM queue_items
        WHERE conversation_id=? AND dispatch_session_id IS NOT NULL`,
        )
        .all(conversationId) as { id: string }[];
      const sessions = [
        ...new Set([
          conversation.hermes_session_id,
          ...aliases.map((row) => row.id),
        ]),
      ];
      const results: unknown[] = [];
      for (let index = 0; index < sessions.length; index += 8) {
        const group = sessions.slice(index, index + 8);
        for (const id of group) await this.register(conversationId, id);
        results.push(await this.client.reconcile(conversation.id, group));
      }
      return results;
    })();
    this.reconcileFlights.set(conversationId, flight);
    try {
      return await flight;
    } finally {
      if (this.reconcileFlights.get(conversationId) === flight)
        this.reconcileFlights.delete(conversationId);
    }
  }

  findStored(conversationId: string, assetId: string): MediaAsset | null {
    const row = this.db
      .prepare(
        `SELECT * FROM media_assets WHERE conversation_id=? AND asset_id=?`,
      )
      .get(conversationId, assetId) as Record<string, unknown> | undefined;
    return row ? this.rowToView(row) : null;
  }

  findManyStored(conversationId: string, assetIds: string[]): MediaAsset[] {
    return assetIds.map((id) => {
      const asset = this.findStored(conversationId, id);
      return (
        asset ?? {
          asset_id: id,
          status: "unavailable",
          source: { kind: "upload", upload_id: "upload_unknown" },
          mime_type: "",
          byte_size: 0,
          width: 0,
          height: 0,
          sha256: "",
          file_name: "图片暂不可用",
          content_url: this.contentUrl(conversationId, id),
        }
      );
    });
  }

  findToolAssetsStored(
    conversationId: string,
    sessionId: string,
    toolCallId: string,
  ): MediaAsset[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM media_assets WHERE conversation_id=?
        AND json_extract(source_json,'$.kind')='tool'
        AND json_extract(source_json,'$.session_id')=?
        AND json_extract(source_json,'$.tool_call_id')=?
      ORDER BY CAST(json_extract(source_json,'$.output_index') AS INTEGER)
    `,
      )
      .all(conversationId, sessionId, toolCallId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToView(row));
  }

  /** Use bound submissions and tool call IDs, never text similarity, for history images. */
  async decorateHistory(
    conversationId: string,
    messages: MessageItem[],
  ): Promise<MessageItem[]> {
    const hasMediaCandidate = messages.some(
      (message) =>
        (message.role === "user" &&
          message.content.endsWith("</emu-media-input-v1>")) ||
        (message.role === "tool" && message.tool_name === "image_generate"),
    );
    let pluginLive = false;
    if (hasMediaCandidate && this.client.isConfigured()) {
      try {
        await this.client.capabilities(1200);
        pluginLive = true;
      } catch {
        // The cached metadata below still gives images a stable placeholder.
      }
    }
    const decorated: MessageItem[] = [];
    for (const message of messages) {
      const inherited = this.db
        .prepare(
          `SELECT asset_ids_json,source_operation_id
        FROM media_branch_messages WHERE target_scope_id=? AND target_message_id=?`,
        )
        .get(conversationId, message.id) as
        | {
            asset_ids_json: string;
            source_operation_id: string | null;
          }
        | undefined;
      if (inherited) {
        const assets: MediaAsset[] = [];
        for (const assetId of JSON.parse(
          inherited.asset_ids_json,
        ) as string[]) {
          try {
            if (!pluginLive) throw new Error("offline");
            assets.push(
              this.saveAsset(
                conversationId,
                await this.client.getAsset(conversationId, assetId, 2000),
              ),
            );
          } catch {
            const cached = this.findStored(conversationId, assetId);
            assets.push(
              cached
                ? { ...cached, status: "unavailable" }
                : this.findManyStored(conversationId, [assetId])[0]!,
            );
          }
        }
        const original =
          message.role === "user" ? parseMediaRunInput(message.content) : null;
        decorated.push({
          ...message,
          content:
            original && inherited.source_operation_id === original.operationId
              ? original.displayText
              : message.content,
          attachments: assets,
          ...(inherited.source_operation_id
            ? { media_operation_id: inherited.source_operation_id }
            : {}),
        });
        continue;
      }
      if (message.role === "user") {
        const parsed = parseMediaRunInput(message.content);
        const currentSession =
          this.conversations.findById(conversationId)?.hermes_session_id;
        if (
          !parsed ||
          parsed.scopeId !== conversationId ||
          (parsed.sessionId !== message.session_id &&
            currentSession !== message.session_id)
        ) {
          decorated.push(message);
          continue;
        }
        let verified = hasSubmissionProof(this.db, parsed);
        if (!verified) {
          const local = this.db
            .prepare(
              `SELECT * FROM queue_items
            WHERE operation_id=? AND conversation_id=?`,
            )
            .get(parsed.operationId, conversationId) as
            QueueItemEntity | undefined;
          if (local) preserveFrozenSubmissionProof(this.db, local);
          verified = hasSubmissionProof(this.db, parsed);
        }
        if (!verified && pluginLive) {
          try {
            const remote = await this.client.getSubmission(
              conversationId,
              parsed.operationId,
              2000,
            );
            verified =
              remote.scope_id === conversationId &&
              remote.operation_id === parsed.operationId &&
              remote.session_id === parsed.sessionId &&
              remote.run_input_sha256 === parsed.runInputSha256 &&
              remote.user_text_sha256 === parsed.userTextSha256 &&
              JSON.stringify(remote.asset_ids) ===
                JSON.stringify(parsed.assetIds);
          } catch {
            // Unproven manifests are left intact instead of stripping user text.
          }
        }
        if (!verified) {
          decorated.push(message);
          continue;
        }
        const recorded = this.db.transaction(() => {
          const queue = this.db
            .prepare(
              `SELECT id FROM queue_items WHERE conversation_id=? AND operation_id=?`,
            )
            .get(conversationId, parsed.operationId) as
            { id: string } | undefined;
          if (
            !recordSubmissionProof(
              this.db,
              parsed,
              queue ? `ref_queue_${queue.id}` : undefined,
            )
          )
            return false;
          const proof = this.db
            .prepare(
              `SELECT queue_reference_id FROM media_submission_proofs
            WHERE conversation_id=? AND operation_id=?`,
            )
            .get(conversationId, parsed.operationId) as {
            queue_reference_id: string | null;
          };
          enqueueMediaSync(
            this.db,
            `history_${conversationId}_${parsed.operationId}`,
            conversationId,
            "history_handoff",
            {
              session_id: parsed.sessionId,
              message_id: message.id,
              operation_id: parsed.operationId,
              asset_ids: parsed.assetIds,
              queue_reference_id: proof.queue_reference_id,
            },
          );
          return true;
        })();
        if (!recorded) {
          decorated.push(message);
          continue;
        }
        const attachments: MediaAsset[] = [];
        for (const assetId of parsed.assetIds) {
          try {
            if (!pluginLive) throw new Error("offline");
            const remote = await this.client.getAsset(
              conversationId,
              assetId,
              2000,
            );
            attachments.push(this.saveAsset(conversationId, remote));
          } catch {
            const cached = this.findStored(conversationId, assetId);
            attachments.push(
              cached
                ? { ...cached, status: "unavailable" }
                : this.findManyStored(conversationId, [assetId])[0]!,
            );
          }
        }
        decorated.push({
          ...message,
          content: parsed.displayText,
          attachments,
          media_operation_id: parsed.operationId,
        });
        continue;
      }
      if (
        message.role === "tool" &&
        message.tool_name === "image_generate" &&
        message.tool_call_id
      ) {
        let attachments = this.findToolAssetsStored(
          conversationId,
          message.session_id,
          message.tool_call_id,
        );
        try {
          if (!pluginLive) throw new Error("offline");
          const listed = await this.client.listAssets(
            conversationId,
            {
              tool_call_id: message.tool_call_id,
              limit: 16,
            },
            2000,
          );
          attachments = listed.data
            .map((asset) => this.saveAsset(conversationId, asset))
            .filter(
              (asset) =>
                asset.source.kind === "tool" &&
                asset.source.session_id === message.session_id &&
                asset.source.tool_call_id === message.tool_call_id,
            );
        } catch {
          attachments = attachments.map((asset) => ({
            ...asset,
            status: asset.status === "ready" ? "unavailable" : asset.status,
          }));
        }
        decorated.push({ ...message, attachments });
        continue;
      }
      decorated.push(message);
    }
    return decorated;
  }

  private saveAsset(conversationId: string, asset: PluginAsset): MediaAsset {
    if (asset.scope_id !== conversationId)
      throw new StateConflictError("Image belongs to another conversation");
    const orphanTask = this.db
      .prepare(`SELECT 1 FROM media_outbox WHERE id=?`)
      .get(`orphan_${conversationId}_${asset.asset_id}`);
    if (
      orphanTask &&
      !hasLocalMediaReference(this.db, conversationId, asset.asset_id)
    )
      asset = { ...asset, status: "unavailable" };
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO media_assets(conversation_id,asset_id,status,source_json,mime_type,byte_size,width,height,
                               sha256,file_name,capture_error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id,asset_id) DO UPDATE SET
        status=excluded.status,source_json=excluded.source_json,mime_type=excluded.mime_type,
        byte_size=excluded.byte_size,width=excluded.width,height=excluded.height,
        sha256=excluded.sha256,file_name=excluded.file_name,
        capture_error=excluded.capture_error,updated_at=excluded.updated_at
    `,
      )
      .run(
        conversationId,
        asset.asset_id,
        asset.status,
        JSON.stringify(asset.source),
        asset.mime_type,
        asset.byte_size,
        asset.width,
        asset.height,
        asset.sha256,
        asset.file_name,
        asset.capture_error ?? null,
        now,
        now,
      );
    return this.toView(conversationId, asset);
  }

  private rowToView(row: Record<string, unknown>): MediaAsset {
    const conversationId = String(row["conversation_id"]);
    const assetId = String(row["asset_id"]);
    return {
      asset_id: assetId,
      status: row["status"] as MediaAsset["status"],
      source: JSON.parse(String(row["source_json"])) as MediaAsset["source"],
      mime_type: String(row["mime_type"]),
      byte_size: Number(row["byte_size"]),
      width: Number(row["width"]),
      height: Number(row["height"]),
      sha256: String(row["sha256"]),
      file_name: String(row["file_name"]),
      ...(row["capture_error"]
        ? { capture_error: String(row["capture_error"]) }
        : {}),
      content_url: this.contentUrl(conversationId, assetId),
    };
  }

  private toView(conversationId: string, asset: PluginAsset): MediaAsset {
    return {
      asset_id: asset.asset_id,
      status: asset.status,
      source: asset.source,
      mime_type: asset.mime_type,
      byte_size: asset.byte_size,
      width: asset.width,
      height: asset.height,
      sha256: asset.sha256,
      file_name: asset.file_name,
      ...(asset.capture_error ? { capture_error: asset.capture_error } : {}),
      content_url: this.contentUrl(conversationId, asset.asset_id),
    };
  }

  private contentUrl(conversationId: string, assetId: string): string {
    return `/api/v1/conversations/${encodeURIComponent(conversationId)}/media/assets/${encodeURIComponent(assetId)}/content`;
  }

  private requireConversation(conversationId: string): ConversationEntity {
    const conversation = this.conversations.findById(conversationId);
    if (!conversation) throw new LocalNotFoundError("Conversation not found");
    if (conversation.delete_state !== "none")
      throw new StateConflictError(
        "Conversation is unavailable while deletion is pending",
      );
    return conversation;
  }
}
