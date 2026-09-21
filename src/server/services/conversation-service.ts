import type {
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationSummary,
  DeleteConversationRequest,
  DeleteConversationResponse,
  MessageItem,
  MessageListResponse,
  PatchHermesMetadataRequest,
  PatchLocalMetadataRequest,
} from "../../shared/api-schemas.js";
import type { PauseReason } from "../../shared/domain-enums.js";
import { generateConversationId } from "../../shared/ids.js";
import type {
  ConversationEntity,
  QueueItemEntity,
} from "../db/schema-types.js";
import type {
  ConversationRepository,
  DraftRepository,
} from "../db/repositories/conversation.repository.js";
import type { QueueRepository } from "../db/repositories/queue.repository.js";
import type { RunRepository } from "../db/repositories/run.repository.js";
import {
  DeleteUnconfirmedError,
  HermesBusyGlobalError,
  HermesNotFoundError,
  LocalNotFoundError,
  InvalidRequestError,
  LocalConflictError,
  StateConflictError,
} from "../domain/errors.js";
import type { HermesAdapter } from "../hermes/adapter.js";
import type { SSEHub } from "../sse/sse-hub.js";
import type {
  HermesMessageItem,
  HermesSessionDetailResponse,
} from "../../shared/hermes-schemas.js";

export interface ListConversationsParams {
  limit?: number | undefined;
  offset?: number | undefined;
}

/** Maps Hermes resources into local conversation projections. */
export class ConversationService {
  constructor(
    private readonly hermesAdapter: HermesAdapter,
    private readonly conversationRepo: ConversationRepository,
    private readonly draftRepo: DraftRepository,
    private readonly queueRepo: QueueRepository,
    private readonly runRepo: RunRepository,
    private readonly sseHub: SSEHub,
  ) {}

  async listConversations(
    params: ListConversationsParams = {},
  ): Promise<ConversationListResponse> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);

    // The local registry is the ownership boundary. Never discover or adopt
    // sessions created by another Hermes client.
    const registered: Array<{
      conversation: ConversationEntity;
      remote: HermesSessionDetailResponse;
    }> = [];
    for (const conversation of this.conversationRepo.list()) {
      try {
        const remote = await this.hermesAdapter.getSession(
          conversation.hermes_session_id,
        );
        this.conversationRepo.updateLastSeen(
          conversation.id,
          remote.updated_at,
        );
        registered.push({ conversation, remote });
      } catch (error) {
        if (!(error instanceof HermesNotFoundError)) throw error;
        this.removeMissingLocalConversation(conversation);
      }
    }

    const page = registered.slice(offset, offset + limit);
    return {
      items: page.map(({ conversation, remote }) =>
        this.toSummary(conversation, remote),
      ),
      limit,
      offset,
      has_more: offset + page.length < registered.length,
    };
  }

  async getConversation(
    conversationId: string,
  ): Promise<ConversationDetailResponse> {
    const conversation = this.requireConversation(conversationId);
    const remote = await this.hermesAdapter.getSession(
      conversation.hermes_session_id,
    );
    this.conversationRepo.updateLastSeen(conversation.id, remote.updated_at);
    const refreshed =
      this.conversationRepo.findById(conversation.id) ?? conversation;
    return this.toDetail(refreshed, remote);
  }

  async getMessages(
    conversationId: string,
    pagination: {
      limit?: number;
      offset?: number;
      order?: "oldest" | "latest";
    } = {},
  ): Promise<MessageListResponse> {
    const conversation = this.requireConversation(conversationId);
    const upstream = await this.hermesAdapter.getSessionMessages(
      conversation.hermes_session_id,
      pagination,
    );

    if (upstream.session_id !== conversation.hermes_session_id) {
      this.conversationRepo.adoptEffectiveHermesSessionId(
        conversation.id,
        upstream.session_id,
      );
    }

    const items = upstream.messages.map((message) =>
      this.toMessageItem(message),
    );
    return {
      items,
      effective_hermes_session_id: upstream.session_id,
      limit: upstream.limit,
      offset: upstream.offset,
      order: upstream.order,
      returned: items.length,
    };
  }

  async createConversation(
    data: { title?: string | undefined } = {},
  ): Promise<ConversationDetailResponse> {
    const remote = await this.hermesAdapter.createSession(
      data.title === undefined ? {} : { title: data.title },
    );
    const conversation = this.ensureConversation(remote);
    return this.toDetail(conversation, remote);
  }

  async updateHermesMetadata(
    conversationId: string,
    request: PatchHermesMetadataRequest,
  ): Promise<ConversationDetailResponse> {
    const conversation = this.requireMutableConversation(conversationId);
    await this.hermesAdapter.updateSession(
      conversation.hermes_session_id,
      request.field === "title"
        ? { title: request.value }
        : { pinned: request.value },
    );
    const afterPatch = this.requireMutableConversation(
      conversation.id,
      conversation.hermes_session_id,
    );
    // Hermes PATCH is not the authoritative detail representation.
    const remote = await this.hermesAdapter.getSession(
      afterPatch.hermes_session_id,
    );
    const refreshed = this.requireMutableConversation(
      conversation.id,
      conversation.hermes_session_id,
    );
    this.conversationRepo.updateLastSeen(refreshed.id, remote.updated_at);
    return this.toDetail(refreshed, remote);
  }

  async updateLocalMetadata(
    conversationId: string,
    request: PatchLocalMetadataRequest,
  ): Promise<ConversationDetailResponse> {
    const conversation = this.requireMutableConversation(conversationId);
    if (request.tags === undefined && request.custom_order === undefined) {
      throw new InvalidRequestError(
        "At least one local metadata field is required",
      );
    }

    const remote = await this.hermesAdapter.getSession(
      conversation.hermes_session_id,
    );
    this.requireMutableConversation(
      conversation.id,
      conversation.hermes_session_id,
    );
    const updated = this.conversationRepo.updateMetadata(
      conversation.id,
      request.expected_revision,
      {
        ...(request.tags === undefined
          ? {}
          : { tags_json: JSON.stringify(request.tags) }),
        ...(request.custom_order === undefined
          ? {}
          : { custom_order: request.custom_order }),
      },
    );
    const refreshed = this.requireMutableConversation(
      updated.id,
      conversation.hermes_session_id,
    );
    return this.toDetail(refreshed, remote);
  }

  async forkConversation(
    conversationId: string,
    data: { title?: string | undefined } = {},
  ): Promise<ConversationDetailResponse> {
    const conversation = this.requireMutableConversation(conversationId);
    this.ensureNoActiveRun(conversation);
    const remote = await this.hermesAdapter.forkSession(
      conversation.hermes_session_id,
      data.title === undefined ? {} : { title: data.title },
    );
    await this.ensureSourceStillMutableAfterCreatingSession(
      conversation,
      remote.id,
    );
    const fork = this.ensureConversation(remote);
    return this.toDetail(fork, remote);
  }

  async resetConversation(
    conversationId: string,
    data: { title?: string | undefined } = {},
  ): Promise<ConversationDetailResponse> {
    const conversation = this.requireMutableConversation(conversationId);
    this.ensureNoActiveRun(conversation);
    const remote = await this.hermesAdapter.createSession(
      data.title === undefined ? {} : { title: data.title },
    );
    await this.ensureSourceStillMutableAfterCreatingSession(
      conversation,
      remote.id,
    );
    const reset = this.ensureConversation(remote);
    return this.toDetail(reset, remote);
  }

  async deleteConversation(
    conversationId: string,
    request: DeleteConversationRequest,
  ): Promise<DeleteConversationResponse> {
    const conversation = this.requireConversation(conversationId);
    if (!request.confirmed) {
      throw new DeleteUnconfirmedError(
        "Conversation deletion requires confirmed=true",
      );
    }
    if (conversation.hermes_session_id !== request.expected_hermes_session_id) {
      throw new LocalConflictError(
        "expected_hermes_session_id does not match the current mapping",
      );
    }
    this.ensureNoActiveRun(conversation);
    if (this.queueRepo.findActiveByConversation(conversation.id)) {
      throw new LocalConflictError(
        "Cannot delete a conversation with an active queue item",
      );
    }

    // Mark synchronously before any upstream await. The coordinator already
    // excludes pending deletions, so queued work cannot race into dispatch.
    const deletingConversation = this.conversationRepo.beginDeletion(
      conversation.id,
      request.expected_hermes_session_id,
    );
    try {
      await this.hermesAdapter.getSession(
        deletingConversation.hermes_session_id,
      );
    } catch (error) {
      if (error instanceof HermesNotFoundError)
        return this.completeLocalDeletion(deletingConversation);
      this.markDeleteFailure(deletingConversation.id, error);
      throw error;
    }

    let health;
    try {
      health = await this.hermesAdapter.getDetailedHealth();
    } catch (error) {
      this.conversationRepo.setDeleteState(deletingConversation.id, "none");
      throw error;
    }
    if (health.active_agents !== 0) {
      this.conversationRepo.setDeleteState(deletingConversation.id, "none");
      throw new HermesBusyGlobalError(
        "Cannot delete while Hermes reports active agents",
      );
    }

    try {
      await this.hermesAdapter.deleteSession(
        deletingConversation.hermes_session_id,
      );
    } catch (error) {
      if (error instanceof HermesNotFoundError) {
        try {
          await this.hermesAdapter.getSession(
            deletingConversation.hermes_session_id,
          );
        } catch (confirmError) {
          if (confirmError instanceof HermesNotFoundError)
            return this.completeLocalDeletion(deletingConversation);
          this.markDeleteFailure(deletingConversation.id, confirmError);
          throw confirmError;
        }
      }
      this.markDeleteFailure(deletingConversation.id, error);
      throw error;
    }

    return this.completeLocalDeletion(deletingConversation);
  }

  private completeLocalDeletion(
    conversation: ConversationEntity,
  ): DeleteConversationResponse {
    const runIds = this.runRepo
      .listByConversation(conversation.id)
      .map((run) => run.id);
    try {
      if (!this.conversationRepo.delete(conversation.id))
        throw new LocalNotFoundError(
          "Conversation was already removed locally",
        );
    } catch (error) {
      if (this.conversationRepo.findById(conversation.id))
        this.markDeleteFailure(conversation.id, error);
      throw error;
    }
    for (const runId of runIds) this.sseHub.cleanup(runId);
    return {
      conversation_id: conversation.id,
      hermes_deleted: true,
      local_cleaned: true,
    };
  }

  private removeMissingLocalConversation(
    conversation: ConversationEntity,
  ): void {
    const runIds = this.runRepo
      .listByConversation(conversation.id)
      .map((run) => run.id);
    if (!this.conversationRepo.delete(conversation.id)) return;
    for (const runId of runIds) this.sseHub.cleanup(runId);
  }

  private markDeleteFailure(conversationId: string, error: unknown): void {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string"
        ? (error as { code: string }).code
        : error instanceof Error
          ? error.name
          : "HERMES_DELETE_FAILED";
    this.conversationRepo.setDeleteState(conversationId, "failed", code);
  }

  private ensureConversation(
    remote: HermesSessionDetailResponse,
    tagsJson = "[]",
  ): ConversationEntity {
    const existing = this.conversationRepo.findBySessionId(remote.id);
    if (existing) {
      this.conversationRepo.updateLastSeen(existing.id, remote.updated_at);
      return this.conversationRepo.findById(existing.id) ?? existing;
    }

    const conversation = this.conversationRepo.insert({
      id: generateConversationId(),
      hermes_profile: "default",
      hermes_session_id: remote.id,
      tags_json: tagsJson,
      custom_order: null,
      queue_paused: 0,
      pause_reason: null,
      delete_state: "none",
      delete_error_code: null,
      last_seen_upstream_at: remote.updated_at,
    });
    this.draftRepo.saveDraft(conversation.id, "");
    return conversation;
  }

  private requireConversation(conversationId: string): ConversationEntity {
    const conversation = this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new LocalNotFoundError(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }

  private requireMutableConversation(
    conversationId: string,
    expectedHermesSessionId?: string,
  ): ConversationEntity {
    const conversation = this.requireConversation(conversationId);
    if (conversation.delete_state !== "none") {
      throw new StateConflictError(
        "Conversation is unavailable while deletion is pending or failed",
        { current_state: conversation.delete_state },
      );
    }
    if (
      expectedHermesSessionId !== undefined &&
      conversation.hermes_session_id !== expectedHermesSessionId
    ) {
      throw new LocalConflictError(
        "Hermes session mapping changed while the request was in progress",
      );
    }
    return conversation;
  }

  private async ensureSourceStillMutableAfterCreatingSession(
    source: ConversationEntity,
    createdSessionId: string,
  ): Promise<void> {
    try {
      this.requireMutableConversation(source.id, source.hermes_session_id);
    } catch (error) {
      try {
        await this.hermesAdapter.deleteSession(createdSessionId);
      } catch {
        throw new LocalConflictError(
          "Conversation changed while creating a session; manual Hermes cleanup is required",
          { hermes_session_id: createdSessionId },
        );
      }
      throw error;
    }
  }

  private ensureNoActiveRun(conversation: ConversationEntity): void {
    if (this.runRepo.findActiveByConversation(conversation.id)) {
      throw new LocalConflictError("Conversation has an active run");
    }
  }

  private toSummary(
    conversation: ConversationEntity,
    remote: HermesSessionDetailResponse,
  ): ConversationSummary {
    const queueItems = this.queueRepo.listByConversation(conversation.id);
    const activeRun = this.runRepo.findActiveByConversation(conversation.id);
    return {
      conversation_id: conversation.id,
      hermes_session_id: conversation.hermes_session_id,
      effective_hermes_session_id: remote.id,
      title: remote.title,
      pinned: remote.pinned,
      tags: this.parseTags(conversation.tags_json),
      custom_order: conversation.custom_order,
      last_active: this.toTimestamp(remote.last_active_at),
      message_count: remote.message_count,
      preview: remote.preview,
      has_active_run: activeRun !== null,
      queue_size: queueItems.filter((item) => !this.isTerminalQueueState(item))
        .length,
      queue_paused: conversation.queue_paused === 1,
      has_recovery: queueItems.some((item) => this.hasRecovery(item)),
      delete_state: conversation.delete_state,
      local_revision: conversation.metadata_revision,
    };
  }

  private toDetail(
    conversation: ConversationEntity,
    remote: HermesSessionDetailResponse,
  ): ConversationDetailResponse {
    const summary = this.toSummary(conversation, remote);
    return {
      ...summary,
      parent_session_id: remote.parent_session_id,
      pause_reason: conversation.pause_reason as PauseReason | null,
      current_local_run_id:
        this.runRepo.findActiveByConversation(conversation.id)?.id ?? null,
      delete_failed_reason: conversation.delete_error_code,
    };
  }

  private toMessageItem(message: HermesMessageItem): MessageItem {
    return {
      id: message.id,
      session_id: message.session_id,
      role: message.role,
      content: message.content,
      tool_call_id: message.tool_call_id ?? null,
      tool_name: message.tool_name ?? null,
      timestamp: message.timestamp,
      token_count: message.token_count ?? null,
      finish_reason: message.finish_reason ?? null,
      reasoning: message.reasoning ?? message.reasoning_content ?? null,
      display_kind: message.display_kind ?? null,
    };
  }

  private parseTags(value: string): string[] {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) &&
        parsed.every((tag) => typeof tag === "string")
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  private toTimestamp(value: string | number): number {
    if (typeof value === "number") return Math.max(0, value);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  private isTerminalQueueState(item: QueueItemEntity): boolean {
    return item.state === "done" || item.state === "cancelled";
  }

  private hasRecovery(item: QueueItemEntity): boolean {
    if (!item.recovery_expires_at) return false;
    const expiresAt = Date.parse(item.recovery_expires_at);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }
}
