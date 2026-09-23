import { describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import { StateConflictError } from "../../src/server/domain/errors.js";
import { SSEHub } from "../../src/server/sse/sse-hub.js";

function makeReply() {
  const writes: string[] = [];
  const handlers = new Map<string, () => void>();
  const raw = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }),
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
    end: vi.fn(),
  };
  return {
    reply: { raw } as unknown as FastifyReply,
    raw,
    writes,
    close: () => handlers.get("close")?.(),
  };
}

describe("SSEHub browser run stream contract", () => {
  it("writes stream.ready then numeric run.event replay frames", () => {
    const hub = new SSEHub();
    hub.publishRunEvent(
      "lr_run",
      1,
      "message.delta",
      { delta: "hello" },
      "2026-09-20T00:00:00.000Z",
    );
    const { reply, writes } = makeReply();

    hub.subscribe("lr_run", reply, 0);

    expect(writes[0]).toBe(
      'event: stream.ready\ndata: {"local_run_id":"lr_run","earliest_seq":1,"latest_seq":1}\n\n',
    );
    expect(writes[0]).not.toContain("\nid:");
    expect(writes[1]).toBe(
      'id: 1\nevent: run.event\ndata: {"local_run_id":"lr_run","local_seq":1,"type":"message.delta","payload":{"delta":"hello"},"received_at":"2026-09-20T00:00:00.000Z"}\n\n',
    );
    hub.close();
  });

  it("emits documented replay gaps for process restart and a cursor ahead of durable state", () => {
    const restartedHub = new SSEHub();
    restartedHub.setRunSequenceResolver((runId) =>
      runId === "lr_restart" ? 7 : null,
    );
    const restarted = makeReply();

    restartedHub.subscribe("lr_restart", restarted.reply, 3);

    expect(restarted.writes[0]).toContain('"earliest_seq":8,"latest_seq":7');
    expect(restarted.writes[1]).toContain("event: stream.gap");
    expect(restarted.writes[1]).toContain('"reason":"process_restarted"');
    restartedHub.close();

    const hub = new SSEHub();
    hub.publishRunEvent("lr_ahead", 2, "message.delta", { delta: "x" });
    const ahead = makeReply();
    hub.subscribe("lr_ahead", ahead.reply, 3);

    expect(ahead.writes[1]).toContain('"reason":"cursor_ahead"');
    hub.close();
  });

  it("reports buffer eviction, keeps heartbeats unnumbered, and enforces per-run limits", () => {
    const hub = new SSEHub();
    (hub as unknown as { maxEvents: number }).maxEvents = 2;
    hub.publishRunEvent("lr_evict", 1, "message.delta", { delta: "a" });
    hub.publishRunEvent("lr_evict", 2, "message.delta", { delta: "b" });
    hub.publishRunEvent("lr_evict", 3, "message.delta", { delta: "c" });
    const replay = makeReply();
    hub.subscribe("lr_evict", replay.reply, 0);

    expect(replay.writes[1]).toContain('"reason":"buffer_evicted"');
    hub.sendHeartbeat();
    expect(replay.writes.at(-1)).toBe(": keepalive\n\n");

    const limitHub = new SSEHub();
    for (let index = 0; index < 5; index += 1) {
      limitHub.subscribe("lr_limit", makeReply().reply);
    }
    expect(() => limitHub.subscribe("lr_limit", makeReply().reply)).toThrow(
      StateConflictError,
    );
    limitHub.close();
    hub.close();
  });
});
