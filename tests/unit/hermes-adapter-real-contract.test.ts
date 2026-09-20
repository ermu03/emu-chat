import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesAdapter } from "../../src/server/hermes/adapter.js";
import {
  HermesClient,
  type HermesSseEvent,
} from "../../src/server/hermes/client.js";
import { evaluateHermesCapabilities } from "../../src/server/hermes/capabilities.js";
import {
  HermesNotReadyError,
  HermesProtocolError,
} from "../../src/server/domain/errors.js";
import { LIMITS } from "../../src/shared/limits.js";
import {
  realHermesCapabilities,
  realHermesDetailedHealth,
  realHermesFlatSseEvent,
  realHermesMessageList,
  realHermesMismatchedSessionDetail,
  realHermesNonOkDetailedHealth,
  realHermesReplayAdmission,
  realHermesSessionDetail,
} from "../fixtures/hermes/real-hermes-021.fixture.js";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdapter(): HermesAdapter {
  return new HermesAdapter(
    new HermesClient({
      baseUrl: "http://hermes.test",
      token: "test-token",
    }),
  );
}

async function consumeEvents(
  adapter: HermesAdapter,
  runId: string,
): Promise<void> {
  await adapter.streamEvents("", runId).next();
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("HermesAdapter real Hermes 0.21 contract", () => {
  it("combines operational health with the declared capabilities endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(realHermesDetailedHealth))
      .mockResolvedValueOnce(jsonResponse(realHermesCapabilities));
    globalThis.fetch = fetchMock as typeof fetch;

    const health = await makeAdapter().getDetailedHealth();

    expect(health).toMatchObject({
      status: "ok",
      version: "0.21.3",
      durable: true,
      retention_seconds: 86_400,
      runtime: { mode: "server_agent", tool_execution: "server" },
    });
    expect(health.endpoints).toContainEqual({
      method: "POST",
      path: "/v1/runs",
    });
    expect(evaluateHermesCapabilities(health)).toMatchObject({
      healthy: true,
      missingCapabilities: [],
    });
    expect(
      fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/health/detailed", "/v1/capabilities"]);
  });

  it("uses the shared upstream read timeout for both health probes", async () => {
    const client = new HermesClient({
      baseUrl: "http://hermes.test",
      token: "test-token",
    });
    const requestSpy = vi
      .spyOn(client, "request")
      .mockResolvedValueOnce(realHermesDetailedHealth)
      .mockResolvedValueOnce(realHermesCapabilities);

    await new HermesAdapter(client).getDetailedHealth();

    expect(requestSpy).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/health/detailed",
      timeoutMs: LIMITS.UPSTREAM_READ_TIMEOUT_MS,
    });
    expect(requestSpy).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/v1/capabilities",
      timeoutMs: LIMITS.UPSTREAM_READ_TIMEOUT_MS,
    });
  });

  it("does not admit work while native health is not ok", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(realHermesNonOkDetailedHealth))
      .mockResolvedValueOnce(jsonResponse(realHermesCapabilities));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(makeAdapter().assertReady()).rejects.toBeInstanceOf(
      HermesNotReadyError,
    );
  });

  it("normalizes wrapped detail responses and sparse message pagination", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(realHermesSessionDetail))
      .mockResolvedValueOnce(jsonResponse(realHermesMessageList));
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = makeAdapter();

    const detail = await adapter.getSession("api_anonymous_session");
    const messages = await adapter.getSessionMessages("api_anonymous_session", {
      limit: 25,
      offset: 0,
      order: "oldest",
    });

    expect(detail).toMatchObject({
      id: "api_anonymous_session",
      preview: "",
      created_at: "2024-09-19T23:06:40.000Z",
      updated_at: "2024-09-19T23:06:40.000Z",
    });
    expect(messages).toMatchObject({
      session_id: "api_anonymous_session",
      limit: 25,
      offset: 0,
      order: "oldest",
      messages: [{ tool_calls: null, token_count: null }],
    });
  });

  it("rejects detail and update responses for a different session", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(realHermesMismatchedSessionDetail),
      );
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = makeAdapter();

    await expect(
      adapter.getSession("api_anonymous_session"),
    ).rejects.toBeInstanceOf(HermesProtocolError);
    await expect(
      adapter.updateSession("api_anonymous_session", { title: "renamed" }),
    ).rejects.toBeInstanceOf(HermesProtocolError);
  });

  it("accepts idempotency replays and flat run SSE envelopes", async () => {
    const client = new HermesClient({
      baseUrl: "http://hermes.test",
      token: "test-token",
    });
    const requestSpy = vi
      .spyOn(client, "request")
      .mockResolvedValue(realHermesReplayAdmission);
    vi.spyOn(client, "stream").mockImplementation(async function* () {
      yield {
        event: "message",
        data: JSON.stringify(realHermesFlatSseEvent),
      } satisfies HermesSseEvent;
      yield {
        event: "message",
        data: JSON.stringify({
          event: "run.completed",
          run_id: "run_anonymous",
          timestamp: 1_726_790_801,
          output: "",
        }),
      } satisfies HermesSseEvent;
    });
    const adapter = new HermesAdapter(client);

    const admission = await adapter.startRun("api_anonymous_session", {
      prompt: "test",
      idempotency_key: "idem_anonymous",
    });
    const events = [];
    for await (const event of adapter.streamEvents("", admission.run_id))
      events.push(event);

    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/runs" }),
    );
    expect(admission).toEqual(realHermesReplayAdmission);
    expect(events).toEqual([
      { type: "message.delta", data: { delta: "partial response" } },
      { type: "run.completed", data: { output: "" } },
    ]);
  });

  it.each([
    ["a different run id", { ...realHermesFlatSseEvent, run_id: "run_other" }],
    ["a missing run id", { event: "message.delta", timestamp: 1_726_790_800 }],
    [
      "a missing timestamp",
      { event: "message.delta", run_id: "run_anonymous" },
    ],
    [
      "an invalid timestamp",
      {
        event: "message.delta",
        run_id: "run_anonymous",
        timestamp: -1,
      },
    ],
  ])("rejects a flat SSE envelope with %s", async (_description, payload) => {
    const client = new HermesClient({
      baseUrl: "http://hermes.test",
      token: "test-token",
    });
    vi.spyOn(client, "stream").mockImplementation(async function* () {
      yield {
        event: "message",
        data: JSON.stringify(payload),
      } satisfies HermesSseEvent;
    });
    const adapter = new HermesAdapter(client);

    await expect(
      consumeEvents(adapter, "run_anonymous"),
    ).rejects.toBeInstanceOf(HermesProtocolError);
  });

  it("uses only native stop and approval operations", async () => {
    const client = new HermesClient({
      baseUrl: "http://hermes.test",
      token: "test-token",
    });
    const requestSpy = vi.spyOn(client, "request").mockResolvedValue({});
    const adapter = new HermesAdapter(client);

    expect("cancelRun" in adapter).toBe(false);

    await adapter.stopRun("run_native");
    await adapter.submitApproval("run_native", "once", "approval_native");
    await adapter.submitApproval("run_native", "deny");

    expect(requestSpy).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/v1/runs/run_native/stop",
      body: {},
    });
    expect(requestSpy).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1/runs/run_native/approval",
      body: { choice: "once", request_id: "approval_native" },
    });
    expect(requestSpy).toHaveBeenNthCalledWith(3, {
      method: "POST",
      path: "/v1/runs/run_native/approval",
      body: { choice: "deny" },
    });
  });
});
