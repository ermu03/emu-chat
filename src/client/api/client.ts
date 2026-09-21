import type {
  ApiErrorEnvelope,
  ConnectionStatusResponse,
  ConversationDetailResponse,
  ConversationListResponse,
  CreateConversationRequest,
  ResetConversationRequest,
  ForkConversationRequest,
  PatchHermesMetadataRequest,
  PatchLocalMetadataRequest,
  DeleteConversationRequest,
  DeleteConversationResponse,
  MessageListResponse,
  DraftResponse,
  PutDraftRequest,
  SendMessageRequest,
  SendMessageResponse,
  QueueListResponse,
  QueueItemResponse,
  PatchQueueItemRequest,
  CancelQueueItemRequest,
  RunResponse,
  ApprovalRequest,
  ReconcileResponse,
  PreferencesResponse,
  PutPreferencesRequest,
} from "../../shared/api-schemas.js";

export class ApiClientError extends Error {
  public readonly envelope: ApiErrorEnvelope;

  constructor(envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
    this.name = "ApiClientError";
    this.envelope = envelope;
  }
}

export interface ClientConfig {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class EmuChatApiClient {
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(config: ClientConfig = {}) {
    this.baseUrl = config.baseUrl || "";
    this.fetchFn = config.fetchFn || globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init?.headers);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await this.fetchFn(url, {
      ...init,
      headers,
    });

    if (!res.ok) {
      let envelope: ApiErrorEnvelope;
      try {
        envelope = (await res.json()) as ApiErrorEnvelope;
      } catch {
        envelope = {
          error: {
            code: "INTERNAL_ERROR",
            message: `HTTP ${res.status}: ${res.statusText}`,
            retryable: false,
            action: "none",
            request_id: "rq_client_synthetic",
          },
        };
      }
      throw new ApiClientError(envelope);
    }

    return (await res.json()) as T;
  }

  // --- Status ---
  getStatus(): Promise<ConnectionStatusResponse> {
    return this.request<ConnectionStatusResponse>("/api/v1/status");
  }

  recheckStatus(): Promise<ConnectionStatusResponse> {
    return this.request<ConnectionStatusResponse>("/api/v1/status/recheck", {
      method: "POST",
    });
  }

  // --- Conversations ---
  listConversations(params?: {
    limit?: number;
    offset?: number;
  }): Promise<ConversationListResponse> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    const query = searchParams.toString();
    return this.request<ConversationListResponse>(
      `/api/v1/conversations${query ? `?${query}` : ""}`,
    );
  }

  createConversation(
    data?: CreateConversationRequest,
  ): Promise<ConversationDetailResponse> {
    return this.request<ConversationDetailResponse>("/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(data || {}),
    });
  }

  getConversation(conversationId: string): Promise<ConversationDetailResponse> {
    return this.request<ConversationDetailResponse>(
      `/api/v1/conversations/${conversationId}`,
    );
  }

  resetConversation(
    conversationId: string,
    data?: ResetConversationRequest,
  ): Promise<ConversationDetailResponse> {
    return this.request<ConversationDetailResponse>(
      `/api/v1/conversations/${conversationId}/reset`,
      {
        method: "POST",
        body: JSON.stringify(data || {}),
      },
    );
  }

  forkConversation(
    conversationId: string,
    data?: ForkConversationRequest,
  ): Promise<ConversationDetailResponse> {
    return this.request<ConversationDetailResponse>(
      `/api/v1/conversations/${conversationId}/fork`,
      {
        method: "POST",
        body: JSON.stringify(data || {}),
      },
    );
  }

  patchHermesMetadata(
    conversationId: string,
    data: PatchHermesMetadataRequest,
  ): Promise<ConversationDetailResponse> {
    return this.request<ConversationDetailResponse>(
      `/api/v1/conversations/${conversationId}/hermes-metadata`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    );
  }

  patchLocalMetadata(
    conversationId: string,
    data: PatchLocalMetadataRequest,
  ): Promise<ConversationDetailResponse> {
    return this.request<ConversationDetailResponse>(
      `/api/v1/conversations/${conversationId}/local-metadata`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    );
  }

  deleteConversation(
    conversationId: string,
    data: DeleteConversationRequest,
  ): Promise<DeleteConversationResponse> {
    return this.request<DeleteConversationResponse>(
      `/api/v1/conversations/${conversationId}/delete`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  }

  // --- Messages ---
  listMessages(
    conversationId: string,
    params?: { limit?: number; offset?: number; order?: "oldest" | "latest" },
  ): Promise<MessageListResponse> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    if (params?.order) searchParams.set("order", params.order);

    const query = searchParams.toString();
    return this.request<MessageListResponse>(
      `/api/v1/conversations/${conversationId}/messages${query ? `?${query}` : ""}`,
    );
  }

  // --- Draft ---
  getDraft(conversationId: string): Promise<DraftResponse> {
    return this.request<DraftResponse>(
      `/api/v1/conversations/${conversationId}/draft`,
    );
  }

  putDraft(
    conversationId: string,
    data: PutDraftRequest,
  ): Promise<DraftResponse> {
    return this.request<DraftResponse>(
      `/api/v1/conversations/${conversationId}/draft`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    );
  }

  // --- Queue ---
  sendMessage(
    conversationId: string,
    data: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      `/api/v1/conversations/${conversationId}/messages`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  }

  getQueue(
    conversationId: string,
    params?: { include_terminal?: boolean },
  ): Promise<QueueListResponse> {
    const searchParams = new URLSearchParams();
    if (params?.include_terminal !== undefined) {
      searchParams.set("include_terminal", String(params.include_terminal));
    }
    const query = searchParams.toString();
    return this.request<QueueListResponse>(
      `/api/v1/conversations/${conversationId}/queue${query ? `?${query}` : ""}`,
    );
  }

  patchQueueItem(
    queueItemId: string,
    data: PatchQueueItemRequest,
  ): Promise<QueueItemResponse> {
    return this.request<QueueItemResponse>(
      `/api/v1/queue-items/${queueItemId}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    );
  }

  cancelQueueItem(
    queueItemId: string,
    data: CancelQueueItemRequest,
  ): Promise<QueueItemResponse> {
    return this.request<QueueItemResponse>(
      `/api/v1/queue-items/${queueItemId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  }

  // --- Runs ---
  getRun(localRunId: string): Promise<RunResponse> {
    return this.request<RunResponse>(`/api/v1/runs/${localRunId}`);
  }

  stopRun(localRunId: string): Promise<RunResponse> {
    return this.request<RunResponse>(`/api/v1/runs/${localRunId}/stop`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  submitApproval(
    localRunId: string,
    data: ApprovalRequest,
  ): Promise<RunResponse> {
    return this.request<RunResponse>(`/api/v1/runs/${localRunId}/approval`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  reconcileRun(localRunId: string): Promise<ReconcileResponse> {
    return this.request<ReconcileResponse>(
      `/api/v1/runs/${localRunId}/reconcile`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  }

  // --- Preferences ---
  getPreferences(): Promise<PreferencesResponse> {
    return this.request<PreferencesResponse>("/api/v1/preferences");
  }

  putPreferences(data: PutPreferencesRequest): Promise<PreferencesResponse> {
    return this.request<PreferencesResponse>("/api/v1/preferences", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }
}

export const apiClient = new EmuChatApiClient();
