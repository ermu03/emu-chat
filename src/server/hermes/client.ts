import {
  HermesAuthFailedError,
  HermesConflictError,
  HermesNotFoundError,
  HermesProtocolError,
  HermesTemporaryFailureError,
  HermesUnavailableError,
} from "../domain/errors.js";

export interface HermesClientOptions {
  baseUrl: string;
  token?: string;
  defaultTimeoutMs?: number;
  /** Legacy constructor alias. */
  timeoutMs?: number;
  maxBodySizeBytes?: number;
}

export interface HermesRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HermesSseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Thin server-only HTTP client. It never exposes the bearer token to callers. */
export class HermesClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly maxBodySizeBytes: number;

  constructor(options: HermesClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token?.trim() || undefined;
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? options.timeoutMs ?? 10_000;
    this.maxBodySizeBytes = options.maxBodySizeBytes ?? 4 * 1024 * 1024;
  }

  isConfigured(): boolean {
    return this.token !== undefined;
  }

  async request<T = unknown>(opts: HermesRequestOptions): Promise<T> {
    this.assertConfigured();
    const method = opts.method ?? "GET";
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const url = this.buildUrl(opts.path, opts.query);
    const headers = this.buildHeaders(opts.headers, opts.path);
    const body =
      opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      const text = await this.readBoundedText(response);
      this.throwForStatus(response.status, opts.path);
      if (!text.trim()) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new HermesProtocolError(
          `Hermes response is not valid JSON: ${(error as Error).message}`,
        );
      }
    } catch (error) {
      if (
        error instanceof HermesAuthFailedError ||
        error instanceof HermesNotFoundError ||
        error instanceof HermesConflictError ||
        error instanceof HermesTemporaryFailureError ||
        error instanceof HermesUnavailableError ||
        error instanceof HermesProtocolError
      )
        throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new HermesUnavailableError(
          `Hermes request timed out after ${timeoutMs}ms`,
        );
      throw new HermesUnavailableError(
        `Failed to reach Hermes: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse one upstream SSE response. The caller owns the single consumer. */
  async *stream(
    path: string,
    options: { timeoutMs?: number; headers?: Record<string, string> } = {},
  ): AsyncGenerator<HermesSseEvent> {
    this.assertConfigured();
    const timeoutMs = options.timeoutMs ?? 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.buildUrl(path), {
        method: "GET",
        headers: this.buildHeaders(
          { Accept: "text/event-stream", ...(options.headers ?? {}) },
          path,
        ),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        await this.readBoundedText(response).catch(() => undefined);
        this.throwForStatus(response.status, path);
        throw new HermesProtocolError(
          `Hermes SSE response has no body (${response.status})`,
        );
      }
      clearTimeout(timer);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let eventId: string | undefined;
      let dataLines: string[] = [];
      const flush = (): HermesSseEvent | null => {
        if (dataLines.length === 0) return null;
        const event: HermesSseEvent = {
          event: eventName,
          data: dataLines.join("\n"),
          ...(eventId === undefined ? {} : { id: eventId }),
        };
        eventName = "message";
        eventId = undefined;
        dataLines = [];
        return event;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > 256 * 1024)
          throw new HermesProtocolError("Hermes SSE frame exceeds limit");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "") {
            const event = flush();
            if (event) yield event;
            continue;
          }
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const valueText =
            colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") eventName = valueText;
          else if (field === "id") eventId = valueText;
          else if (field === "data") dataLines.push(valueText);
        }
      }
      const finalEvent = flush();
      if (finalEvent) yield finalEvent;
    } catch (error) {
      if (
        error instanceof HermesAuthFailedError ||
        error instanceof HermesNotFoundError ||
        error instanceof HermesConflictError ||
        error instanceof HermesTemporaryFailureError ||
        error instanceof HermesUnavailableError ||
        error instanceof HermesProtocolError
      )
        throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new HermesUnavailableError("Hermes SSE connection timed out");
      throw new HermesUnavailableError(
        `Hermes SSE connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(
      `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
    );
    if (query)
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new HermesAuthFailedError("Hermes API key is not configured");
    }
  }

  private buildHeaders(
    extra: Record<string, string> | undefined,
    path: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: path.endsWith("/events")
        ? "text/event-stream"
        : "application/json",
      "User-Agent": "emu-chat/0.1.0",
      ...(extra ?? {}),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    delete headers["X-Hermes-Session-Key"];
    delete headers["x-hermes-session-key"];
    return headers;
  }

  private async readBoundedText(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > this.maxBodySizeBytes)
      throw new HermesProtocolError("Hermes response exceeds size limit");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > this.maxBodySizeBytes)
      throw new HermesProtocolError("Hermes response exceeds size limit");
    return text;
  }

  private throwForStatus(status: number, path: string): void {
    if (status >= 200 && status < 300) return;
    if (status === 401 || status === 403)
      throw new HermesAuthFailedError(
        `Hermes authentication failed (${status})`,
        status,
      );
    if (status === 404)
      throw new HermesNotFoundError(
        `Hermes resource not found: ${path}`,
        status,
      );
    if (status === 409)
      throw new HermesConflictError(`Hermes conflict: ${path}`, status);
    if (status === 408 || status === 425 || status === 429)
      throw new HermesTemporaryFailureError(
        `Hermes temporary failure (${status})`,
        status,
      );
    if (status >= 500)
      throw new HermesUnavailableError(
        `Hermes unavailable (${status})`,
        status,
      );
    throw new HermesProtocolError(`Hermes unexpected status (${status})`);
  }
}
