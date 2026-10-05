import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HermesClient } from "../../src/server/hermes/client.js";
import { HermesAdapter } from "../../src/server/hermes/adapter.js";
import {
  HermesAuthFailedError,
  HermesNotFoundError,
  HermesUnavailableError,
  HermesProtocolError,
} from "../../src/server/domain/errors.js";

describe("HermesClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("injects Bearer token, Accept, User-Agent, and never sets X-Hermes-Session-Key", async () => {
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers;
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:8642",
      token: "secret-test-token",
      defaultTimeoutMs: 5000,
    });

    const data = await client.request({ path: "/test" });
    expect(data).toEqual({ status: "ok" });

    const headers = capturedHeaders as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-test-token");
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("emu-chat/0.1.0");
    expect(headers["X-Hermes-Session-Key"]).toBeUndefined();
  });

  it("maps 401 to HermesAuthFailedError", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:8642",
      token: "bad-token",
    });

    await expect(client.request({ path: "/health" })).rejects.toThrow(
      HermesAuthFailedError,
    );
  });

  it("maps 404 to HermesNotFoundError", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:8642",
      token: "test-token",
    });

    await expect(
      client.request({ path: "/sessions/not-found" }),
    ).rejects.toThrow(HermesNotFoundError);
  });

  it("maps 503 to HermesUnavailableError", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:8642",
      token: "test-token",
    });

    await expect(client.request({ path: "/health" })).rejects.toThrow(
      HermesUnavailableError,
    );
  });

  it("maps invalid JSON response to HermesProtocolError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("<html>Bad Gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:8642",
      token: "test-token",
    });

    await expect(client.request({ path: "/json" })).rejects.toThrow(
      HermesProtocolError,
    );
  });

  it("rejects an empty API key before issuing HTTP or SSE requests", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:8642",
      token: "   ",
    });

    expect(client.isConfigured()).toBe(false);
    await expect(client.request({ path: "/health/detailed" })).rejects.toThrow(
      HermesAuthFailedError,
    );
    await expect(client.stream("/v1/runs/run_1/events").next()).rejects.toThrow(
      HermesAuthFailedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a silently open SSE connection after the liveness timeout", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof fetch;
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:8642",
      token: "test-token",
    });

    await expect(
      client
        .stream("/v1/runs/run_silent/events", { livenessTimeoutMs: 20 })
        .next(),
    ).rejects.toBeInstanceOf(HermesUnavailableError);
  });

  it("releases the request and reader when an SSE consumer exits early", async () => {
    const cancel = vi.fn();
    let signal!: AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
      cancel,
    });
    globalThis.fetch = vi.fn(async (_url, init) => {
      signal = init!.signal!;
      return new Response(body);
    });
    const client = new HermesClient({
      baseUrl: "http://hermes.test",
      token: "test",
    });
    const stream = client.stream("/v1/runs/run_1/events");
    expect((await stream.next()).value).toMatchObject({ data: "first" });
    await stream.return(undefined);
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("cancels an in-flight read through the adapter on service shutdown", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    let signal!: AbortSignal;
    globalThis.fetch = vi.fn(async (_url, init) => {
      signal = init!.signal!;
      return new Response(body);
    });
    const adapter = new HermesAdapter(
      new HermesClient({ baseUrl: "http://hermes.test", token: "test" }),
    );
    const controller = new AbortController();
    const stream = adapter.streamEvents("ses_1", "run_1", controller.signal);
    const reading = stream.next();
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    expect((await reading).done).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("releases an upstream reader when the adapter rejects a malformed event", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: invalid-json\n\n"));
      },
      cancel,
    });
    let signal!: AbortSignal;
    globalThis.fetch = vi.fn(async (_url, init) => {
      signal = init!.signal!;
      return new Response(body);
    });
    const adapter = new HermesAdapter(
      new HermesClient({ baseUrl: "http://hermes.test", token: "test" }),
    );
    await expect(
      adapter.streamEvents("ses_1", "run_1").next(),
    ).rejects.toBeInstanceOf(HermesProtocolError);
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});
