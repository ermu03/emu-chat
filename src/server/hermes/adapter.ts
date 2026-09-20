import {
  HermesCapabilitiesSchema,
  HermesDetailedHealthSchema,
  HermesHealthDetailedResponseSchema,
  type HermesHealthDetailedResponse,
  HermesSessionDetailResponseSchema,
  type HermesSessionDetailResponse,
  HermesSessionEnvelopeSchema,
  type HermesSessionWire,
  HermesMessageListResponseSchema,
  type HermesMessageListResponse,
  type HermesMessageItem,
  HermesRunAdmissionResponseSchema,
  type HermesRunAdmissionResponse,
  HermesRunStatusResponseSchema,
  type HermesRunStatusResponse,
} from "../../shared/hermes-schemas.js";
import { LIMITS } from "../../shared/limits.js";
import { HermesProtocolError, HermesNotReadyError } from "../domain/errors.js";
import type { HermesClient, HermesSseEvent } from "./client.js";
import { evaluateHermesCapabilities } from "./capabilities.js";

export interface HermesRunEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
}

export interface NormalizedMessageList {
  session_id: string;
  messages: HermesMessageItem[];
  total: number;
  limit: number;
  offset: number;
  order: "oldest" | "latest";
  has_more: boolean;
}

export class HermesAdapter {
  constructor(private readonly client: HermesClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async getDetailedHealth(): Promise<HermesHealthDetailedResponse> {
    const raw = await this.client.request({
      method: "GET",
      path: "/health/detailed",
      timeoutMs: LIMITS.UPSTREAM_READ_TIMEOUT_MS,
    });
    const health = HermesDetailedHealthSchema.safeParse(raw);
    if (!health.success)
      throw new HermesProtocolError(
        `Hermes health schema validation failed: ${health.error.message}`,
      );

    const capabilitiesRaw = await this.client.request({
      method: "GET",
      path: "/v1/capabilities",
      timeoutMs: LIMITS.UPSTREAM_READ_TIMEOUT_MS,
    });
    const capabilities = HermesCapabilitiesSchema.safeParse(capabilitiesRaw);
    if (!capabilities.success)
      throw new HermesProtocolError(
        `Hermes capabilities schema validation failed: ${capabilities.error.message}`,
      );

    const idempotency = capabilities.data.features.runs_idempotency;
    if (
      idempotency.durable === undefined ||
      idempotency.retention_seconds === undefined
    ) {
      throw new HermesProtocolError(
        "Hermes capabilities omit idempotency durability metadata",
      );
    }
    const endpoints = Object.values(capabilities.data.endpoints);
    const normalized = HermesHealthDetailedResponseSchema.safeParse({
      ...health.data,
      runtime: capabilities.data.runtime,
      durable: idempotency.durable,
      retention_seconds: idempotency.retention_seconds,
      features: capabilities.data.features,
      endpoints,
    });
    if (!normalized.success)
      throw new HermesProtocolError(
        `Hermes readiness normalization failed: ${normalized.error.message}`,
      );
    return normalized.data;
  }

  async assertReady(): Promise<void> {
    const health = await this.getDetailedHealth();
    const result = evaluateHermesCapabilities(health);
    if (!result.healthy)
      throw new HermesNotReadyError(
        `Hermes is not compatible: ${result.missingCapabilities.join(", ")}`,
      );
  }

  async getSession(sessionId: string): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: "GET",
      path: `/api/sessions/${encodeURIComponent(sessionId)}`,
    });
    return this.parseSessionResponse(raw, "Hermes session", sessionId);
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
    const value = parsed.data as HermesMessageListResponse;
    const messages = value.data;
    const pagination = value.pagination;
    return {
      session_id: value.session_id,
      messages,
      total: messages.length,
      limit: pagination?.limit ?? query.limit,
      offset: pagination?.offset ?? query.offset,
      order: pagination?.order ?? query.order,
      has_more: false,
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
    return this.parseSessionResponse(raw, "Hermes create session");
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
    return this.parseSessionResponse(raw, "Hermes update session", sessionId);
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
    return this.parseSessionResponse(raw, "Hermes fork session");
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
  ): Promise<HermesRunAdmissionResponse> {
    const headers = data.idempotency_key
      ? { "Idempotency-Key": data.idempotency_key }
      : undefined;
    const raw = await this.client.request({
      method: "POST",
      path: "/v1/runs",
      ...(headers === undefined ? {} : { headers }),
      body: { session_id: sessionId, input: data.prompt },
      timeoutMs: LIMITS.UPSTREAM_RUN_SUBMIT_TIMEOUT_MS,
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
    if (parsed.data.run_id !== runId) {
      throw new HermesProtocolError(
        "Hermes run status response does not match the requested run",
      );
    }
    return parsed.data;
  }

  async stopRun(runId: string): Promise<void> {
    await this.client.request({
      method: "POST",
      path: `/v1/runs/${encodeURIComponent(runId)}/stop`,
      body: {},
    });
  }

  async submitApproval(
    runId: string,
    choice: "once" | "deny",
    requestId?: string,
  ): Promise<void> {
    await this.client.request({
      method: "POST",
      path: `/v1/runs/${encodeURIComponent(runId)}/approval`,
      body: {
        choice,
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
      const parsed = this.parseSseEvent(event, runId);
      if (parsed) yield parsed;
    }
  }

  private parseSseEvent(
    event: HermesSseEvent,
    expectedRunId: string,
  ): HermesRunEvent | null {
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
    if (typeof record.event !== "string" || record.event.length === 0)
      throw new HermesProtocolError(
        "Hermes SSE event is missing an event name",
      );
    if (typeof record.run_id !== "string" || record.run_id !== expectedRunId) {
      throw new HermesProtocolError(
        "Hermes SSE event does not match the requested run",
      );
    }
    if (
      typeof record.timestamp !== "number" ||
      !Number.isFinite(record.timestamp) ||
      record.timestamp < 0
    ) {
      throw new HermesProtocolError(
        "Hermes SSE event has an invalid timestamp",
      );
    }
    return {
      type: record.event,
      data: this.flatEventPayload(record),
      ...(event.id === undefined ? {} : { id: event.id }),
    };
  }

  private parseSessionResponse(
    raw: unknown,
    context: string,
    expectedSessionId?: string,
  ): HermesSessionDetailResponse {
    const envelope = HermesSessionEnvelopeSchema.safeParse(raw);
    if (!envelope.success)
      throw new HermesProtocolError(
        `${context} schema validation failed: ${envelope.error.message}`,
      );
    const session = this.normalizeSession(envelope.data.session);
    if (expectedSessionId !== undefined && session.id !== expectedSessionId) {
      throw new HermesProtocolError(
        `${context} does not match the requested session`,
      );
    }
    return session;
  }

  private normalizeSession(
    session: HermesSessionWire,
  ): HermesSessionDetailResponse {
    const createdSource = session.started_at;
    const lastActiveSource = session.last_active ?? createdSource;
    const normalized: HermesSessionDetailResponse = {
      id: session.id,
      title: session.title,
      pinned: session.pinned,
      created_at: this.toIsoTimestamp(createdSource, "created_at"),
      updated_at: this.toIsoTimestamp(lastActiveSource, "updated_at"),
      last_active_at: this.toIsoTimestamp(lastActiveSource, "last_active_at"),
      message_count: session.message_count,
      preview: session.preview ?? "",
      parent_session_id: session.parent_session_id,
      ...(session.model === undefined || session.model === null
        ? {}
        : { model: session.model }),
      source: session.source,
      archived: session.archived,
      hidden: session.hidden,
    };
    const parsed = HermesSessionDetailResponseSchema.safeParse(normalized);
    if (!parsed.success)
      throw new HermesProtocolError(
        `Hermes session normalization failed: ${parsed.error.message}`,
      );
    return parsed.data;
  }

  private toIsoTimestamp(value: number, field: string): string {
    const milliseconds = value * 1000;
    if (!Number.isFinite(milliseconds))
      throw new HermesProtocolError(`Hermes session has invalid ${field}`);
    return new Date(milliseconds).toISOString();
  }

  private flatEventPayload(
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const payload = { ...record };
    delete payload.event;
    delete payload.run_id;
    delete payload.timestamp;
    return payload;
  }
}
