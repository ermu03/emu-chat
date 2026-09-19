import {
  HermesHealthDetailedResponseSchema,
  type HermesHealthDetailedResponse,
  HermesSessionListResponseSchema,
  type HermesSessionListResponse,
  HermesSessionDetailResponseSchema,
  type HermesSessionDetailResponse,
  HermesMessageListResponseSchema,
  type HermesMessageListResponse
} from '../../shared/hermes-schemas.js';
import { HermesProtocolError } from '../domain/errors.js';
import type { HermesClient } from './client.js';

export class HermesAdapter {
  constructor(private readonly client: HermesClient) {}

  async getDetailedHealth(): Promise<HermesHealthDetailedResponse> {
    const raw = await this.client.request({
      method: 'GET',
      path: '/health/detailed',
      timeoutMs: 5000
    });

    const parsed = HermesHealthDetailedResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HermesProtocolError(
        `Hermes /health/detailed schema validation failed: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  async listSessions(params?: {
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<HermesSessionListResponse> {
    const query: Record<string, string | number | undefined> = {
      source: 'api_server',
      limit: params?.limit ?? 50,
      offset: params?.offset ?? 0
    };
    if (params?.search) {
      query.search = params.search;
    }

    const raw = await this.client.request({
      method: 'GET',
      path: '/api/sessions',
      query
    });

    const parsed = HermesSessionListResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HermesProtocolError(
        `Hermes /api/sessions schema validation failed: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  async getSession(sessionId: string): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: 'GET',
      path: `/api/sessions/${sessionId}`
    });

    const parsed = HermesSessionDetailResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HermesProtocolError(
        `Hermes /api/sessions/${sessionId} schema validation failed: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  async getSessionMessages(
    sessionId: string,
    params?: {
      limit?: number;
      offset?: number;
      order?: 'oldest' | 'latest';
    }
  ): Promise<HermesMessageListResponse> {
    const query: Record<string, string | number | undefined> = {
      limit: params?.limit ?? 100,
      offset: params?.offset ?? 0,
      order: params?.order ?? 'oldest'
    };

    const raw = await this.client.request({
      method: 'GET',
      path: `/api/sessions/${sessionId}/messages`,
      query
    });

    const parsed = HermesMessageListResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HermesProtocolError(
        `Hermes /api/sessions/${sessionId}/messages schema validation failed: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  async createSession(data: { title?: string }): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: 'POST',
      path: '/api/sessions',
      body: data
    });

    const parsed = HermesSessionDetailResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HermesProtocolError(
        `Hermes POST /api/sessions schema validation failed: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  async updateSession(
    sessionId: string,
    data: { title?: string; pinned?: boolean }
  ): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: 'PATCH',
      path: `/api/sessions/${sessionId}`,
      body: data
    });

    const parsed = HermesSessionDetailResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HermesProtocolError(
        `Hermes PATCH /api/sessions/${sessionId} schema validation failed: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  async forkSession(
    sessionId: string,
    data?: { title?: string }
  ): Promise<HermesSessionDetailResponse> {
    const raw = await this.client.request({
      method: 'POST',
      path: `/api/sessions/${sessionId}/fork`,
      body: data ?? {}
    });

    const parsed = HermesSessionDetailResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HermesProtocolError(
        `Hermes POST /api/sessions/${sessionId}/fork schema validation failed: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.request({
      method: 'DELETE',
      path: `/api/sessions/${sessionId}`
    });
  }
}
