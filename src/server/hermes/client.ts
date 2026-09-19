import {
  HermesAuthFailedError,
  HermesConflictError,
  HermesNotFoundError,
  HermesProtocolError,
  HermesTemporaryFailureError,
  HermesUnavailableError
} from '../domain/errors.js';
import { sanitizedLogger } from '../logging.js';

export interface HermesClientOptions {
  baseUrl: string;
  token?: string;
  defaultTimeoutMs?: number;
  maxBodySizeBytes?: number;
}

export interface HermesRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HermesClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxBodySizeBytes: number;

  constructor(options: HermesClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.maxBodySizeBytes = options.maxBodySizeBytes ?? 4 * 1024 * 1024; // 4 MiB
  }

  async request<T = unknown>(opts: HermesRequestOptions): Promise<T> {
    const method = opts.method ?? 'GET';
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    let urlString = `${this.baseUrl}${opts.path.startsWith('/') ? opts.path : `/${opts.path}`}`;
    if (opts.query) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) {
          sp.append(k, String(v));
        }
      }
      const qs = sp.toString();
      if (qs) {
        urlString += `?${qs}`;
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'emu-chat/0.1.0',
      ...opts.headers
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    // Explicitly guarantee no X-Hermes-Session-Key is ever sent
    delete headers['X-Hermes-Session-Key'];
    delete headers['x-hermes-session-key'];

    let bodyPayload: string | undefined = undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyPayload = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startTime = Date.now();

    try {
      sanitizedLogger.debug(
        `[HermesClient] ${method} ${opts.path} started (timeout: ${timeoutMs}ms)`
      );

      const res = await fetch(urlString, {
        method,
        headers,
        body: bodyPayload,
        signal: controller.signal
      });

      const durationMs = Date.now() - startTime;
      sanitizedLogger.debug(
        `[HermesClient] ${method} ${opts.path} status ${res.status} (${durationMs}ms)`
      );

      if (res.status === 204) {
        return undefined as T;
      }

      // Check Content-Length header first
      const contentLengthHeader = res.headers.get('content-length');
      if (contentLengthHeader) {
        const cl = parseInt(contentLengthHeader, 10);
        if (!isNaN(cl) && cl > this.maxBodySizeBytes) {
          throw new HermesProtocolError(
            `Hermes response size ${cl} bytes exceeds maximum limit ${this.maxBodySizeBytes} bytes`
          );
        }
      }

      const text = await res.text();
      if (text.length > this.maxBodySizeBytes) {
        throw new HermesProtocolError(
          `Hermes response body text length ${text.length} exceeds limit ${this.maxBodySizeBytes}`
        );
      }

      if (res.status === 401 || res.status === 403) {
        throw new HermesAuthFailedError(`Hermes authentication/authorization failed: ${res.status}`);
      }

      if (res.status === 404) {
        throw new HermesNotFoundError(`Hermes resource not found: ${opts.path}`);
      }

      if (res.status === 409) {
        throw new HermesConflictError(`Hermes conflict for ${opts.path}`);
      }

      if (res.status === 408 || res.status === 425 || res.status === 429) {
        throw new HermesTemporaryFailureError(`Hermes transient HTTP error: ${res.status}`);
      }

      if (res.status >= 500) {
        throw new HermesUnavailableError(`Hermes upstream server error: ${res.status}`);
      }

      if (!res.ok) {
        throw new HermesProtocolError(`Hermes unexpected status code: ${res.status}`);
      }

      if (!text.trim()) {
        return {} as T;
      }

      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new HermesProtocolError(
          `Hermes response is not valid JSON: ${(err as Error).message}`
        );
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        throw new HermesUnavailableError(
          `Hermes request timed out after ${timeoutMs}ms for ${method} ${opts.path}`
        );
      }
      if (
        err instanceof HermesAuthFailedError ||
        err instanceof HermesNotFoundError ||
        err instanceof HermesConflictError ||
        err instanceof HermesTemporaryFailureError ||
        err instanceof HermesUnavailableError ||
        err instanceof HermesProtocolError
      ) {
        throw err;
      }
      throw new HermesUnavailableError(
        `Failed to reach Hermes at ${this.baseUrl}: ${(err as Error).message}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
