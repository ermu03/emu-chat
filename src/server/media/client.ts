import { Readable } from "node:stream";
import { z } from "zod";
import {
  AppError,
  InvalidRequestError,
  PayloadTooLargeError,
} from "../domain/errors.js";
import {
  MediaCapabilitiesSchema,
  PluginAssetSchema,
  PluginSubmissionSchema,
  type MediaCapabilities,
  type PluginAsset,
} from "../../shared/media-schemas.js";

const JSON_LIMIT = 128 * 1024;
const PREFIX = "/v1/emu-media";

export class MediaUnavailableError extends AppError {
  constructor(message = "图片服务暂时不可用") {
    super({
      code: "MEDIA_UNAVAILABLE",
      message,
      statusCode: 503,
      retryable: true,
      action: "retry",
    });
  }
}

export class MediaConflictError extends AppError {
  constructor(message = "图片状态已变化，请刷新后重试") {
    super({
      code: "MEDIA_CONFLICT",
      message,
      statusCode: 409,
      retryable: false,
      action: "resolve_conflict",
    });
  }
}

const ListSchema = z.object({
  protocol_version: z.literal(1),
  data: z.array(PluginAssetSchema),
  next_cursor: z.string().nullable(),
});

/** Service-only client; never reused for browser-facing arbitrary proxy requests. */
export class MediaClient {
  private readonly baseUrl: string;
  private readonly key: string;

  constructor(baseUrl: string, key: string | undefined) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.key = key?.trim() ?? "";
  }

  isConfigured(): boolean {
    return this.key.length > 0;
  }

  async capabilities(timeoutMs?: number): Promise<MediaCapabilities> {
    return MediaCapabilitiesSchema.parse(
      await this.json("GET", "/capabilities", undefined, timeoutMs),
    );
  }

  async registerSession(scopeId: string, sessionId: string): Promise<void> {
    await this.json(
      "PUT",
      `/scopes/${encodeURIComponent(scopeId)}/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  async upload(
    scopeId: string,
    uploadId: string,
    mime: string,
    fileName: string,
    stream: Readable,
    signal?: AbortSignal,
  ): Promise<PluginAsset> {
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime))
      throw new InvalidRequestError("只支持 PNG、JPEG 和 WebP 图片");
    if (!/^upload_[A-Za-z0-9_-]{1,121}$/.test(uploadId))
      throw new InvalidRequestError("Invalid image upload identity");
    const response = await this.fetchPlugin(
      "POST",
      `/scopes/${encodeURIComponent(scopeId)}/uploads`,
      {
        headers: {
          "Content-Type": mime,
          "Idempotency-Key": uploadId,
          "X-File-Name": encodeURIComponent(fileName.slice(0, 120)),
        },
        body: stream as unknown as RequestInit["body"],
        duplex: "half",
        signal,
      } as RequestInit,
    );
    return PluginAssetSchema.parse(await this.readJson(response));
  }

  async getAsset(
    scopeId: string,
    assetId: string,
    timeoutMs?: number,
  ): Promise<PluginAsset> {
    return PluginAssetSchema.parse(
      await this.json(
        "GET",
        this.assetPath(scopeId, assetId),
        undefined,
        timeoutMs,
      ),
    );
  }

  async listAssets(
    scopeId: string,
    query: {
      cursor?: string | undefined;
      limit?: number | undefined;
      operation_id?: string | undefined;
      session_id?: string | undefined;
      tool_call_id?: string | undefined;
    } = {},
    timeoutMs?: number,
  ) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) search.set(key, String(value));
    const suffix = search.size ? `?${search.toString()}` : "";
    return ListSchema.parse(
      await this.json(
        "GET",
        `/scopes/${encodeURIComponent(scopeId)}/assets${suffix}`,
        undefined,
        timeoutMs,
      ),
    );
  }

  async getContent(scopeId: string, assetId: string): Promise<Response> {
    return this.fetchPlugin(
      "GET",
      `${this.assetPath(scopeId, assetId)}/content`,
      {},
      90_000,
    );
  }

  async putReference(
    scopeId: string,
    referenceId: string,
    body: {
      version: 1;
      kind: "draft" | "queue" | "history" | "branch" | "upload";
      revision: number;
      session_id: string | null;
      asset_ids: string[];
    },
  ): Promise<void> {
    await this.json(
      "PUT",
      `/scopes/${encodeURIComponent(scopeId)}/references/${encodeURIComponent(referenceId)}`,
      body,
    );
  }

  async deleteReference(scopeId: string, referenceId: string): Promise<void> {
    await this.json(
      "DELETE",
      `/scopes/${encodeURIComponent(scopeId)}/references/${encodeURIComponent(referenceId)}`,
    );
  }

  async bindSubmission(
    scopeId: string,
    operationId: string,
    body: {
      version: 1;
      session_id: string;
      asset_ids: string[];
      user_text_sha256: string;
      run_input_sha256: string;
    },
  ): Promise<void> {
    await this.json(
      "PUT",
      `/scopes/${encodeURIComponent(scopeId)}/submissions/${encodeURIComponent(operationId)}`,
      body,
    );
  }

  async getSubmission(
    scopeId: string,
    operationId: string,
    timeoutMs?: number,
  ) {
    return PluginSubmissionSchema.parse(
      await this.json(
        "GET",
        `/scopes/${encodeURIComponent(scopeId)}/submissions/${encodeURIComponent(operationId)}`,
        undefined,
        timeoutMs,
      ),
    );
  }

  async reconcile(scopeId: string, sessionIds: string[], limit = 200) {
    return this.json(
      "POST",
      `/scopes/${encodeURIComponent(scopeId)}/reconcile`,
      { version: 1, session_ids: sessionIds, limit },
    );
  }

  async retryCapture(scopeId: string, assetId: string): Promise<void> {
    await this.json(
      "POST",
      `${this.assetPath(scopeId, assetId)}/retry-capture`,
    );
  }

  async releaseOrphan(scopeId: string, assetId: string): Promise<void> {
    await this.json(
      "POST",
      `${this.assetPath(scopeId, assetId)}/release-orphan`,
    );
  }

  async grantAsset(
    scopeId: string,
    assetId: string,
    sourceScopeId: string,
  ): Promise<PluginAsset> {
    return PluginAssetSchema.parse(
      await this.json(
        "PUT",
        `/scopes/${encodeURIComponent(scopeId)}/grants/${encodeURIComponent(assetId)}`,
        { version: 1, source_scope_id: sourceScopeId },
      ),
    );
  }

  async deleteScope(scopeId: string): Promise<void> {
    await this.json("DELETE", `/scopes/${encodeURIComponent(scopeId)}`);
  }

  private assetPath(scopeId: string, assetId: string): string {
    if (!/^asset_[A-Za-z0-9_-]{1,122}$/.test(assetId))
      throw new InvalidRequestError("Invalid image asset ID");
    return `/scopes/${encodeURIComponent(scopeId)}/assets/${assetId}`;
  }

  private async json(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await this.fetchPlugin(
      method,
      path,
      body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
      timeoutMs,
    );
    return this.readJson(response);
  }

  private async fetchPlugin(
    method: string,
    path: string,
    extra: RequestInit = {},
    timeoutMs?: number,
  ): Promise<Response> {
    if (!this.key) throw new MediaUnavailableError("图片插件密钥未配置");
    const timeout = AbortSignal.timeout(
      timeoutMs ?? (method === "POST" ? 90_000 : 20_000),
    );
    const signal = extra.signal
      ? AbortSignal.any([timeout, extra.signal])
      : timeout;
    try {
      const response = await fetch(this.baseUrl + PREFIX + path, {
        ...extra,
        method,
        redirect: "manual",
        signal,
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(extra.headers ?? {}),
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 409 || response.status === 410)
          throw new MediaConflictError();
        if (response.status === 413)
          throw new PayloadTooLargeError("图片超过服务端限制");
        if (response.status === 415 || response.status === 422)
          throw new InvalidRequestError("图片格式或请求无效");
        throw new MediaUnavailableError();
      }
      return response;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new MediaUnavailableError();
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    if (!response.body) throw new MediaUnavailableError("图片插件响应为空");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > JSON_LIMIT)
          throw new MediaUnavailableError("图片插件响应过大");
        parts.push(value);
      }
      return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
    } catch {
      throw new MediaUnavailableError("图片插件响应无效");
    } finally {
      reader.releaseLock();
    }
  }
}
