import type {
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationSummary,
  DeleteConversationRequest,
  DeleteConversationResponse,
  MessageListResponse,
  PatchHermesMetadataRequest,
  PatchLocalMetadataRequest
} from '../../shared/api-schemas.js';
import type { PauseReason } from '../../shared/domain-enums.js';
import { generateId } from '../../shared/ids.js';
import type {
  ConversationRepository,
  DraftRepository
} from '../db/repositories/conversation.repository.js';
import type { QueueRepository } from '../db/repositories/queue.repository.js';
import type { RunRepository } from '../db/repositories/run.repository.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError
} from '../domain/errors.js';
import type { HermesAdapter } from '../hermes/adapter.js';
import { sanitizedLogger } from '../logging.js';

export interface ListConversationsParams {
  limit?: number;
  offset?: number;
  session_id?: string;
  title?: string;
}

export class ConversationService {
  constructor(
    private readonly hermesAdapter: HermesAdapter,
    private readonly conversationRepo: ConversationRepository,
    private readonly draftRepo: DraftRepository,
    private readonly queueRepo: QueueRepository,
    private readonly runRepo: RunRepository
  ) {}

  async listConversations(params: ListConversationsParams = {}): Promise<ConversationListResponse> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);

    // If exact session_id query is requested
    if (params.session_id) {
      const sessionId = params.session_id.trim();
      let conv = this.conversationRepo.findBySessionId(sessionId);
      if (!conv) {
        // Probe upstream Hermes
        try {
          const remote = await this.hermesAdapter.getSession(sessionId);
          const newId = generateId('conversation');
          conv = this.conversationRepo.insert({
            id: newId,
            hermes_profile: 'default',
            hermes_session_id: remote.id,
            tags_json: '[]',
            custom_order: null,
            queue_paused: 0,
            pause_reason: null,
            delete_state: 'none',
            metadata_revision: 1,
            last_seen_upstream_at: remote.updated_at
          });
          this.draftRepo.saveDraft(newId, '');
        } catch {
          return {
            items: [],
            total: 0,
            limit,
            offset,
            has_more: false
          };
        }
      }

      // Fetch remote detail for summary
      const remote = await this.hermesAdapter.getSession(conv.hermes_session_id);
      const queueItems = this.queueRepo.findByConversationId(conv.id);
      const queueSize = queueItems.filter(
        (q) => q.state === 'queued' || q.state === 'dispatching'
      ).length;

      const summary: ConversationSummary = {
        id: conv.id,
        hermes_session_id: conv.hermes_session_id,
        title: remote.title ?? 'Untitled',
        pinned: Boolean(remote.pinned),
        tags: JSON.parse(conv.tags_json || '[]'),
        custom_order: conv.custom_order,
        queue_paused: Boolean(conv.queue_paused),
        pause_reason: conv.pause_reason as PauseReason | null,
        delete_state: conv.delete_state as 'none' | 'pending' | 'failed',
        metadata_revision: conv.metadata_revision,
        last_seen_upstream_at: conv.last_seen_upstream_at,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        message_count: remote.message_count ?? 0,
        preview: remote.preview,
        last_active_at: remote.last_active_at,
        queue_size: queueSize
      };

      return {
        items: [summary],
        total: 1,
        limit,
        offset: 0,
        has_more: false
      };
    }

    // Fetch upstream sessions
    const upstreamRes = await this.hermesAdapter.listSessions({
      limit,
      offset,
      search: params.title
    });

    let upstreamItems = upstreamRes.sessions;

    // Exact title match filter if requested
    if (params.title) {
      const targetTitle = params.title.trim();
      upstreamItems = upstreamItems.filter((s) => s.title === targetTitle);
    }

    const summaries: ConversationSummary[] = [];

    for (const s of upstreamItems) {
      let conv = this.conversationRepo.findBySessionId(s.id);
      if (!conv) {
        const newId = generateId('conversation');
        conv = this.conversationRepo.insert({
          id: newId,
          hermes_profile: 'default',
          hermes_session_id: s.id,
          tags_json: '[]',
          custom_order: null,
          queue_paused: 0,
          pause_reason: null,
          delete_state: 'none',
          metadata_revision: 1,
          last_seen_upstream_at: s.updated_at
        });
        this.draftRepo.saveDraft(newId, '');
      } else {
        this.conversationRepo.updateLastSeen(conv.id, s.updated_at);
      }

      const queueItems = this.queueRepo.findByConversationId(conv.id);
      const queueSize = queueItems.filter(
        (q) => q.state === 'queued' || q.state === 'dispatching'
      ).length;

      summaries.push({
        id: conv.id,
        hermes_session_id: conv.hermes_session_id,
        title: s.title ?? 'Untitled',
        pinned: Boolean(s.pinned),
        tags: JSON.parse(conv.tags_json || '[]'),
        custom_order: conv.custom_order,
        queue_paused: Boolean(conv.queue_paused),
        pause_reason: conv.pause_reason as PauseReason | null,
        delete_state: conv.delete_state as 'none' | 'pending' | 'failed',
        metadata_revision: conv.metadata_revision,
        last_seen_upstream_at: conv.last_seen_upstream_at,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        message_count: s.message_count ?? 0,
        preview: s.preview,
        last_active_at: s.last_active_at,
        queue_size: queueSize
      });
    }

    return {
      items: summaries,
      total: params.title ? summaries.length : upstreamRes.total,
      limit,
      offset,
      has_more: params.title ? false : upstreamRes.has_more
    };
  }

  async getConversation(conversationId: string): Promise<ConversationDetailResponse> {
    const conv = this.conversationRepo.findById(conversationId);
    if (!conv) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }

    const remote = await this.hermesAdapter.getSession(conv.hermes_session_id);
    this.conversationRepo.updateLastSeen(conv.id, remote.updated_at);

    return {
      id: conv.id,
      hermes_session_id: conv.hermes_session_id,
      title: remote.title ?? 'Untitled',
      pinned: Boolean(remote.pinned),
      tags: JSON.parse(conv.tags_json || '[]'),
      custom_order: conv.custom_order,
      queue_paused: Boolean(conv.queue_paused),
      pause_reason: conv.pause_reason as PauseReason | null,
      delete_state: conv.delete_state as 'none' | 'pending' | 'failed',
      metadata_revision: conv.metadata_revision,
      last_seen_upstream_at: conv.last_seen_upstream_at,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      model: remote.model,
      system_prompt: remote.system_prompt,
      parent_session_id: remote.parent_session_id,
      message_count: remote.message_count
    };
  }

  async getMessages(
    conversationId: string,
    pagination: {
      limit?: number;
      offset?: number;
      order?: 'oldest' | 'latest';
    } = {}
  ): Promise<MessageListResponse> {
    const conv = this.conversationRepo.findById(conversationId);
    if (!conv) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }

    const upstreamRes = await this.hermesAdapter.getSessionMessages(
      conv.hermes_session_id,
      pagination
    );

    // If Hermes compressed or moved the resumable tip to a new session ID
    if (upstreamRes.session_id && upstreamRes.session_id !== conv.hermes_session_id) {
      sanitizedLogger.info(
        `[ConversationService] Resumable tip updated for ${conv.id}: ${conv.hermes_session_id} -> ${upstreamRes.session_id}`
      );
      this.conversationRepo.updateHermesSessionId(conv.id, upstreamRes.session_id);
    }

    return {
      conversation_id: conv.id,
      hermes_session_id: upstreamRes.session_id,
      total: upstreamRes.total,
      limit: upstreamRes.limit,
      offset: upstreamRes.offset,
      order: upstreamRes.order,
      has_more: upstreamRes.has_more,
      messages: upstreamRes.messages
    };
  }

  async createConversation(data: { title?: string } = {}): Promise<ConversationDetailResponse> {
    const remote = await this.hermesAdapter.createSession({
      title: data.title
    });

    const newId = generateId('conversation');
    const conv = this.conversationRepo.insert({
      id: newId,
      hermes_profile: 'default',
      hermes_session_id: remote.id,
      tags_json: '[]',
      custom_order: null,
      queue_paused: 0,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: remote.updated_at
    });
    this.draftRepo.saveDraft(newId, '');

    return {
      id: conv.id,
      hermes_session_id: conv.hermes_session_id,
      title: remote.title ?? 'Untitled',
      pinned: Boolean(remote.pinned),
      tags: [],
      custom_order: null,
      queue_paused: false,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: conv.last_seen_upstream_at,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      model: remote.model,
      system_prompt: remote.system_prompt,
      parent_session_id: remote.parent_session_id,
      message_count: remote.message_count
    };
  }

  async updateHermesMetadata(
    conversationId: string,
    request: PatchHermesMetadataRequest
  ): Promise<ConversationDetailResponse> {
    const conv = this.conversationRepo.findById(conversationId);
    if (!conv) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }

    const updated = await this.hermesAdapter.updateSession(conv.hermes_session_id, {
      title: request.title,
      pinned: request.pinned
    });

    this.conversationRepo.updateLastSeen(conv.id, updated.updated_at);
    return this.getConversation(conversationId);
  }

  async updateLocalMetadata(
    conversationId: string,
    request: PatchLocalMetadataRequest
  ): Promise<ConversationDetailResponse> {
    const conv = this.conversationRepo.findById(conversationId);
    if (!conv) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }

    if (request.expected_revision === undefined) {
      throw new ValidationError('expected_revision is required for local metadata update');
    }

    this.conversationRepo.updateMetadata(conversationId, request.expected_revision, {
      tags_json: request.tags ? JSON.stringify(request.tags) : undefined,
      custom_order: request.custom_order
    });

    return this.getConversation(conversationId);
  }

  async forkConversation(
    conversationId: string,
    data: { title?: string } = {}
  ): Promise<ConversationDetailResponse> {
    const conv = this.conversationRepo.findById(conversationId);
    if (!conv) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }

    // Ensure no active run before fork
    const activeRun = this.runRepo.findActiveByConversation(conv.id);
    if (activeRun) {
      throw new ConflictError(
        `Cannot fork conversation ${conversationId} while an active run is in progress`
      );
    }

    const remote = await this.hermesAdapter.forkSession(conv.hermes_session_id, {
      title: data.title
    });

    const newId = generateId('conversation');
    const newConv = this.conversationRepo.insert({
      id: newId,
      hermes_profile: 'default',
      hermes_session_id: remote.id,
      tags_json: conv.tags_json,
      custom_order: null,
      queue_paused: 0,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: remote.updated_at
    });
    this.draftRepo.saveDraft(newId, '');

    return {
      id: newConv.id,
      hermes_session_id: newConv.hermes_session_id,
      title: remote.title ?? 'Untitled',
      pinned: Boolean(remote.pinned),
      tags: JSON.parse(newConv.tags_json || '[]'),
      custom_order: null,
      queue_paused: false,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: newConv.last_seen_upstream_at,
      created_at: newConv.created_at,
      updated_at: newConv.updated_at,
      model: remote.model,
      system_prompt: remote.system_prompt,
      parent_session_id: remote.parent_session_id,
      message_count: remote.message_count
    };
  }

  async resetConversation(
    conversationId: string,
    data: { title?: string } = {}
  ): Promise<ConversationDetailResponse> {
    const conv = this.conversationRepo.findById(conversationId);
    if (!conv) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }

    const activeRun = this.runRepo.findActiveByConversation(conv.id);
    if (activeRun) {
      throw new ConflictError(
        `Cannot reset conversation ${conversationId} while an active run is in progress`
      );
    }

    // Creating a fresh upstream session
    const remote = await this.hermesAdapter.createSession({
      title: data.title ?? 'Reset Session'
    });

    const newId = generateId('conversation');
    const newConv = this.conversationRepo.insert({
      id: newId,
      hermes_profile: 'default',
      hermes_session_id: remote.id,
      tags_json: '[]',
      custom_order: null,
      queue_paused: 0,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: remote.updated_at
    });
    this.draftRepo.saveDraft(newId, '');

    return {
      id: newConv.id,
      hermes_session_id: newConv.hermes_session_id,
      title: remote.title ?? 'Untitled',
      pinned: Boolean(remote.pinned),
      tags: [],
      custom_order: null,
      queue_paused: false,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: newConv.last_seen_upstream_at,
      created_at: newConv.created_at,
      updated_at: newConv.updated_at,
      model: remote.model,
      system_prompt: remote.system_prompt,
      parent_session_id: remote.parent_session_id,
      message_count: remote.message_count
    };
  }

  async deleteConversation(
    conversationId: string,
    req: DeleteConversationRequest
  ): Promise<DeleteConversationResponse> {
    const conv = this.conversationRepo.findById(conversationId);
    if (!conv) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }

    // Gate 1: Check expected_hermes_session_id match
    if (conv.hermes_session_id !== req.expected_hermes_session_id) {
      throw new ConflictError(
        `Session id mismatch: expected ${req.expected_hermes_session_id} but conversation currently maps to ${conv.hermes_session_id}`
      );
    }

    // Gate 2: Local active run and queue check
    const activeRun = this.runRepo.findActiveByConversation(conv.id);
    if (activeRun) {
      throw new ConflictError(
        `Cannot delete conversation ${conversationId} while an active run is in progress`
      );
    }
    const activeQueue = this.queueRepo.findActiveByConversation(conv.id);
    if (activeQueue) {
      throw new ConflictError(
        `Cannot delete conversation ${conversationId} while queue item is active`
      );
    }

    // Gate 3: Hermes upstream active agents check
    const health = await this.hermesAdapter.getDetailedHealth();
    if (health.active_agents > 0) {
      throw new ConflictError(
        `Cannot delete conversation: upstream Hermes currently has ${health.active_agents} active agents running`
      );
    }

    // Mark pending in local SQLite
    this.conversationRepo.setDeleteState(conv.id, 'pending');

    try {
      // Call upstream Hermes DELETE /api/sessions/{session_id}
      await this.hermesAdapter.deleteSession(conv.hermes_session_id);

      // Cascade delete local SQLite records
      this.draftRepo.delete(conv.id);
      this.conversationRepo.delete(conv.id);

      return {
        conversation_id: conv.id,
        deleted: true
      };
    } catch (err) {
      sanitizedLogger.error(
        `[ConversationService] Failed to delete session ${conv.hermes_session_id} from Hermes: ${(err as Error).message}`
      );
      this.conversationRepo.setDeleteState(conv.id, 'failed');
      throw err;
    }
  }
}
