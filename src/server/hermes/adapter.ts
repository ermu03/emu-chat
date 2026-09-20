import {
  HermesHealthDetailedResponseSchema,
  type HermesHealthDetailedResponse,
  HermesSessionListResponseSchema,
  type HermesSessionListResponse,
  HermesSessionDetailResponseSchema,
  type HermesSessionDetailResponse,
  HermesMessageListResponseSchema,
  type HermesMessageListResponse,
  HermesRunAdmissionResponseSchema,
  HermesRunStatusResponseSchema,
  type HermesRunStatusResponse,
} from "../../shared/hermes-schemas.js";
import { HermesProtocolError, HermesNotReadyError } from "../domain/errors.js";
import type { HermesClient, HermesSseEvent } from "./client.js";
import { evaluateHermesCapabilities } from "./capabilities.js";

export interface HermesRunEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
}

export interface NormalizedSessionList {
  sessions: HermesSessionDetailResponse[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface NormalizedMessageList {
  session_id: string;
  messages: HermesMessageListResponse["messages"];
  total: number;
  limit: number;
  offset: number;
  order: "oldest" | "latest";
  has_more: boolean;
}

export class HermesAdapter {
  private lastHealth: HermesHealthDetailedResponse | null = null;

  constructor(private readonly client: HermesClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async getDetailedHealth(): Promise<HermesHealthDetailedResponse> {
    const raw = await this.client.request({
      method: "GET",
      path: "/health/detailed",
      timeoutMs: 5000,
    });
    const parsed = HermesHealthDetailedResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes health schema validation failed: ${parsed.error.message}`,
      );
    this.lastHealth = parsed.data;
    return parsed.data;
  }

  async assertReady(): Promise<void> {
    const health = await this.getDetailedHealth();
    const result = evaluateHermesCapabilities(health);
    if (!result.healthy)
      throw new HermesNotReadyError(
        `Hermes is not compatible: ${result.missingCapabilities.join(", ")}`,
      );
  }

  async listSessions(
    params: { limit?: number; offset?: number; search?: string } = {},
  ): Promise<NormalizedSessionList> {
    const query: Record<string, string | number> = {
      source: "api_server",
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    };
    if (params.search) query.title = params.search;
    const raw = await this.client.request({
      method: "GET",
      path: "/api/sessions",
      query,
    });
    const parsed = HermesSessionListResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes session list schema validation failed: ${parsed.error.message}`,
      );
    const value = parsed.data as HermesSessionListResponse & {
      data?: HermesSessionDetailResponse[];
      sessions?: HermesSessionDetailResponse[];
      total?: number;
    };
    const sessions = value.sessions ?? value.data ?? [];
    return {
      sessions,
      total: value.total ?? sessions.length,
      limit: value.limit ?? (query.limit as number),
      offset: value.offset ?? (query.offset as number),
      has_more: value.has_more ?? false,
    };
  }

  async getSession(sessionId: string): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: "GET",
      path: `/api/sessions/${encodeURIComponent(sessionId)}`,
    });
    const parsed = HermesSessionDetailResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes session schema validation failed: ${parsed.error.message}`,
      );
    return parsed.data;
  }

  async getSessionMessages(
    sessionId: string,
    params: {
      limit?: number;
      offset?: number;
      order?: "oldest" | "latest";
    } = {},
  ): Promise<NormalizedMessageList> {
    const query = {
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
      order: params.order ?? "oldest",
    };
    const raw = await this.client.request({
      method: "GET",
      path: `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      query,
    });
    const parsed = HermesMessageListResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes message list schema validation failed: ${parsed.error.message}`,
      );
    const value = parsed.data as HermesMessageListResponse & {
      data?: HermesMessageListResponse["messages"];
      messages?: HermesMessageListResponse["messages"];
      effective_session_id?: string;
    };
    const messages = value.messages ?? value.data ?? [];
    return {
      session_id: value.effective_session_id ?? value.session_id ?? sessionId,
      messages,
      total: value.total ?? messages.length,
      limit: value.limit ?? query.limit,
      offset: value.offset ?? query.offset,
      order: value.order ?? query.order,
      has_more: value.has_more ?? false,
    };
  }

  async createSession(
    data: { title?: string } = {},
  ): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: "POST",
      path: "/api/sessions",
      ...(Object.keys(data).length ? { body: data } : {}),
    });
    const parsed = HermesSessionDetailResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes create session schema validation failed: ${parsed.error.message}`,
      );
    return parsed.data;
  }

  async updateSession(
    sessionId: string,
    data: { title?: string; pinned?: boolean },
  ): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: "PATCH",
      path: `/api/sessions/${encodeURIComponent(sessionId)}`,
      body: data,
    });
    const parsed = HermesSessionDetailResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes update session schema validation failed: ${parsed.error.message}`,
      );
    return parsed.data;
  }

  async forkSession(
    sessionId: string,
    data: { title?: string } = {},
  ): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: "POST",
      path: `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
      body: data,
    });
    const parsed = HermesSessionDetailResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes fork session schema validation failed: ${parsed.error.message}`,
      );
    return parsed.data;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.request({
      method: "DELETE",
      path: `/api/sessions/${encodeURIComponent(sessionId)}`,
    });
  }

  async startRun(
    sessionId: string,
    data: { prompt: string; idempotency_key?: string },
  ): Promise<{ run_id: string; status: "started"; replayed: boolean }> {
    const headers = data.idempotency_key
      ? { "Idempotency-Key": data.idempotency_key }
      : undefined;
    const raw = await this.client.request({
      method: "POST",
      path: "/v1/runs",
      ...(headers === undefined ? {} : { headers }),
      body: { session_id: sessionId, input: data.prompt },
      timeoutMs: 30_000,
    });
    const parsed = HermesRunAdmissionResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes run admission schema validation failed: ${parsed.error.message}`,
      );
    return parsed.data;
  }

  async getRunStatus(runId: string): Promise<HermesRunStatusResponse> {
    const raw = await this.client.request({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(runId)}`,
    });
    const parsed = HermesRunStatusResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes run status schema validation failed: ${parsed.error.message}`,
      );
    return parsed.data;
  }

  async stopRun(runId: string): Promise<void> {
    await this.client.request({
      method: "POST",
      path: `/v1/runs/${encodeURIComponent(runId)}/stop`,
      body: {},
    });
  }

  async cancelRun(runId: string): Promise<void> {
    return this.stopRun(runId);
  }

  async submitApproval(
    runId: string,
    choice: "once" | "deny" | "approve" | "reject" | "cancel",
    requestId?: string,
  ): Promise<void> {
    const normalized =
      choice === "approve"
        ? "once"
        : choice === "reject" || choice === "cancel"
          ? "deny"
          : choice;
    await this.client.request({
      method: "POST",
      path: `/v1/runs/${encodeURIComponent(runId)}/approval`,
      body: {
        choice: normalized,
        ...(requestId ? { request_id: requestId } : {}),
      },
    });
  }

  async *streamEvents(
    _sessionId: string,
    runId: string,
  ): AsyncGenerator<HermesRunEvent> {
    for await (const event of this.client.stream(
      `/v1/runs/${encodeURIComponent(runId)}/events`,
    )) {
      const parsed = this.parseSseEvent(event);
      if (parsed) yield parsed;
    }
  }

  private parseSseEvent(event: HermesSseEvent): HermesRunEvent | null {
    if (!event.data.trim()) return null;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      throw new HermesProtocolError("Hermes SSE event is not valid JSON");
    }
    if (!data || typeof data !== "object")
      throw new HermesProtocolError(
        "Hermes SSE event payload must be an object",
      );
    const record = data as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : event.event;
    const payload =
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : record;
    return {
      type,
      data: payload,
      ...(event.id === undefined ? {} : { id: event.id }),
    };
  }
}
