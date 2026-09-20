import type { FastifyReply } from "fastify";
import { LIMITS } from "../../shared/limits.js";
import type { StreamGapReason } from "../../shared/domain-enums.js";
import { StateConflictError } from "../domain/errors.js";

/** Compatibility view used by older unit helpers. Browser frames use RunEventEnvelope. */
export interface SSEEnvelope {
  event_id: string;
  seq: number;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface RunEventEnvelope {
  local_run_id: string;
  local_seq: number;
  type: string;
  payload: Record<string, unknown>;
  received_at: string;
}

type BroadcastEnvelope = Omit<SSEEnvelope, "event_id" | "timestamp"> &
  Partial<Pick<SSEEnvelope, "event_id" | "timestamp">>;

interface BufferedRunEvent extends RunEventEnvelope {
  legacy_event_id: string;
}

interface RunStream {
  events: BufferedRunEvent[];
  latest_seq: number;
  dropped_before: number;
  latest_gap?: StreamGapReason;
}

type SequenceResolver = (localRunId: string) => number | null;
type EvictionHandler = (localRunId: string) => void;

/**
 * In-memory browser fan-out. The database owns the durable local sequence;
 * this hub only keeps a bounded replay window for one process lifetime.
 */
export class SSEHub {
  private readonly clients = new Map<string, Set<FastifyReply>>();
  private readonly streams = new Map<string, RunStream>();
  private readonly maxEvents = LIMITS.EVENT_RING_MAX_EVENTS;
  private readonly maxBytes = LIMITS.EVENT_RING_MAX_BYTES;
  private sequenceResolver: SequenceResolver | null = null;
  private evictionHandler: EvictionHandler | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor() {
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      LIMITS.SSE_HEARTBEAT_INTERVAL_MS,
    );
    this.heartbeatTimer.unref();
  }

  setRunSequenceResolver(resolver: SequenceResolver): void {
    this.sequenceResolver = resolver;
  }

  setEvictionHandler(handler: EvictionHandler): void {
    this.evictionHandler = handler;
  }

  /** Subscribe to a run stream using its persisted local sequence as cursor. */
  subscribe(
    localRunId: string,
    reply: FastifyReply,
    after?: string | number,
  ): void {
    if (this.closed) {
      reply.raw.end();
      return;
    }

    const subscribers = this.clients.get(localRunId) ?? new Set<FastifyReply>();
    if (!this.clients.has(localRunId))
      this.clients.set(localRunId, subscribers);
    const globalCount = this.subscriptionCount();
    if (
      !subscribers.has(reply) &&
      subscribers.size >= LIMITS.SSE_MAX_CONNS_PER_RUN
    ) {
      throw new StateConflictError(
        "Too many event-stream connections for this run",
      );
    }
    if (!subscribers.has(reply) && globalCount >= LIMITS.SSE_MAX_CONNS_GLOBAL) {
      throw new StateConflictError("Too many event-stream connections");
    }

    subscribers.add(reply);
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();

    const cursor = this.resolveCursor(localRunId, after);
    const stream = this.streams.get(localRunId);
    const latestSeq = this.latestSequence(localRunId, stream);
    const earliestSeq = stream?.events[0]?.local_seq ?? latestSeq + 1;
    this.writeControl(reply, "stream.ready", {
      local_run_id: localRunId,
      earliest_seq: earliestSeq,
      latest_seq: latestSeq,
    });

    if (cursor !== undefined) {
      const gap = this.replayGap(
        localRunId,
        cursor,
        stream,
        earliestSeq,
        latestSeq,
      );
      if (gap) {
        this.writeControl(reply, "stream.gap", gap);
      } else {
        for (const event of stream?.events ?? []) {
          if (event.local_seq > cursor) this.writeRunEvent(reply, event);
        }
      }
    }

    reply.raw.on("close", () => this.unsubscribe(localRunId, reply));
  }

  unsubscribe(localRunId: string, reply: FastifyReply): void {
    const subscribers = this.clients.get(localRunId);
    if (!subscribers) return;
    subscribers.delete(reply);
    if (subscribers.size === 0) this.clients.delete(localRunId);
  }

  /** Publish one already-persisted, monotonically increasing run event. */
  publishRunEvent(
    localRunId: string,
    localSeq: number,
    type: string,
    payload: Record<string, unknown>,
    receivedAt = new Date().toISOString(),
  ): RunEventEnvelope {
    if (this.closed) {
      return {
        local_run_id: localRunId,
        local_seq: localSeq,
        type,
        payload,
        received_at: receivedAt,
      };
    }
    const event = this.storeRunEvent(
      localRunId,
      localSeq,
      type,
      payload,
      receivedAt,
      String(localSeq),
    );
    for (const reply of this.clients.get(localRunId) ?? [])
      this.writeRunEvent(reply, event);
    return this.toRunEnvelope(event);
  }

  /** Notify current and reconnecting clients that the stream cannot be replayed exactly. */
  publishGap(localRunId: string, reason: StreamGapReason): void {
    if (this.closed) return;
    const stream = this.getStream(localRunId);
    stream.latest_gap = reason;
    const latestSeq = this.latestSequence(localRunId, stream);
    const earliestSeq = stream.events[0]?.local_seq ?? latestSeq + 1;
    const data = {
      local_run_id: localRunId,
      requested_after: latestSeq,
      earliest_seq: earliestSeq,
      latest_seq: latestSeq,
      reason,
    };
    for (const reply of this.clients.get(localRunId) ?? [])
      this.writeControl(reply, "stream.gap", data);
  }

  /**
   * Legacy helper retained for repository-level tests. New coordinator code
   * must call publishRunEvent with a durable sequence instead.
   */
  broadcast(
    key: string,
    typeOrEnvelope: string | BroadcastEnvelope,
    data?: Record<string, unknown>,
  ): SSEEnvelope {
    if (this.closed) {
      const seq = typeof typeOrEnvelope === "string" ? 1 : typeOrEnvelope.seq;
      const type =
        typeof typeOrEnvelope === "string"
          ? typeOrEnvelope
          : typeOrEnvelope.type;
      const payload =
        typeof typeOrEnvelope === "string"
          ? (data ?? {})
          : (typeOrEnvelope.data ?? {});
      const timestamp =
        typeof typeOrEnvelope === "string"
          ? new Date().toISOString()
          : (typeOrEnvelope.timestamp ?? new Date().toISOString());
      return { event_id: String(seq), seq, timestamp, type, data: payload };
    }
    const stream = this.getStream(key);
    const sequence =
      typeof typeOrEnvelope === "string"
        ? Math.max(this.latestSequence(key, stream), stream.latest_seq) + 1
        : typeOrEnvelope.seq;
    const type =
      typeof typeOrEnvelope === "string" ? typeOrEnvelope : typeOrEnvelope.type;
    const payload =
      typeof typeOrEnvelope === "string"
        ? (data ?? {})
        : (typeOrEnvelope.data ?? {});
    const timestamp =
      typeof typeOrEnvelope === "string"
        ? new Date().toISOString()
        : (typeOrEnvelope.timestamp ?? new Date().toISOString());
    const eventId =
      typeof typeOrEnvelope === "string"
        ? String(sequence)
        : (typeOrEnvelope.event_id ?? String(sequence));
    const event = this.storeRunEvent(
      key,
      sequence,
      type,
      payload,
      timestamp,
      eventId,
    );
    for (const reply of this.clients.get(key) ?? [])
      this.writeRunEvent(reply, event);
    return this.toLegacyEnvelope(event);
  }

  getEventHistory(key: string): SSEEnvelope[] {
    return (this.streams.get(key)?.events ?? []).map((event) =>
      this.toLegacyEnvelope(event),
    );
  }

  getMissedEvents(key: string, lastEventId: string | number): SSEEnvelope[] {
    const events = this.streams.get(key)?.events ?? [];
    const cursor = this.resolveCursor(key, lastEventId);
    if (cursor === undefined)
      return [...events].map((event) => this.toLegacyEnvelope(event));
    return events
      .filter((event) => event.local_seq > cursor)
      .map((event) => this.toLegacyEnvelope(event));
  }

  sendHeartbeat(): void {
    for (const [localRunId, subscribers] of this.clients) {
      for (const reply of subscribers)
        this.writeRaw(localRunId, reply, ": keepalive\n\n");
    }
  }

  /** End one run's subscribers and discard its in-memory replay window. */
  cleanup(localRunId: string): void {
    for (const reply of this.clients.get(localRunId) ?? []) {
      try {
        reply.raw.end();
      } catch {
        // A peer may already have closed the socket.
      }
    }
    this.clients.delete(localRunId);
    this.streams.delete(localRunId);
  }

  /** Release all browser streams and timers during application shutdown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const keys = new Set([...this.clients.keys(), ...this.streams.keys()]);
    for (const key of keys) this.cleanup(key);
  }

  private storeRunEvent(
    localRunId: string,
    localSeq: number,
    type: string,
    payload: Record<string, unknown>,
    receivedAt: string,
    legacyEventId: string,
  ): BufferedRunEvent {
    if (!Number.isInteger(localSeq) || localSeq <= 0) {
      throw new TypeError("Run event sequence must be a positive integer");
    }
    const stream = this.getStream(localRunId);
    const existing = stream.events.find(
      (event) => event.local_seq === localSeq,
    );
    if (existing) return existing;
    if (localSeq <= stream.latest_seq) {
      // A stale owner must not overwrite a newer event in the replay window.
      return {
        local_run_id: localRunId,
        local_seq: localSeq,
        type,
        payload,
        received_at: receivedAt,
        legacy_event_id: legacyEventId,
      };
    }
    if (stream.latest_seq > 0 && localSeq > stream.latest_seq + 1) {
      stream.latest_gap = "process_restarted";
    }
    const event: BufferedRunEvent = {
      local_run_id: localRunId,
      local_seq: localSeq,
      type,
      payload,
      received_at: receivedAt,
      legacy_event_id: legacyEventId,
    };
    stream.events.push(event);
    stream.latest_seq = localSeq;

    let evicted = false;
    while (
      stream.events.length > this.maxEvents ||
      this.bufferBytes(stream.events) > this.maxBytes
    ) {
      const removed = stream.events.shift();
      if (removed) {
        stream.dropped_before = Math.max(
          stream.dropped_before,
          removed.local_seq,
        );
        evicted = true;
      }
    }
    if (evicted) {
      stream.latest_gap = "buffer_evicted";
      this.evictionHandler?.(localRunId);
      const latestSeq = this.latestSequence(localRunId, stream);
      const earliestSeq = stream.events[0]?.local_seq ?? latestSeq + 1;
      const data = {
        local_run_id: localRunId,
        requested_after: stream.dropped_before,
        earliest_seq: earliestSeq,
        latest_seq: latestSeq,
        reason: "buffer_evicted" as const,
      };
      for (const reply of this.clients.get(localRunId) ?? []) {
        this.writeControl(reply, "stream.gap", data);
      }
    }
    return event;
  }

  private replayGap(
    localRunId: string,
    after: number,
    stream: RunStream | undefined,
    earliestSeq: number,
    latestSeq: number,
  ): Record<string, unknown> | null {
    let reason: StreamGapReason | null = null;
    if (after > latestSeq) {
      reason = "cursor_ahead";
    } else if (stream && after < stream.dropped_before) {
      reason = "buffer_evicted";
    } else if (!stream && after < latestSeq) {
      reason = "process_restarted";
    } else if (stream?.latest_gap && after < latestSeq) {
      reason = stream.latest_gap;
    }
    if (!reason) return null;
    return {
      local_run_id: localRunId,
      requested_after: after,
      earliest_seq: earliestSeq,
      latest_seq: latestSeq,
      reason,
    };
  }

  private resolveCursor(
    localRunId: string,
    cursor?: string | number,
  ): number | undefined {
    if (cursor === undefined) return undefined;
    if (typeof cursor === "number")
      return Number.isInteger(cursor) && cursor >= 0 ? cursor : undefined;
    const numeric = Number(cursor);
    if (Number.isInteger(numeric) && numeric >= 0) return numeric;
    const event = this.streams
      .get(localRunId)
      ?.events.find((entry) => entry.legacy_event_id === cursor);
    return event?.local_seq;
  }

  private latestSequence(localRunId: string, stream?: RunStream): number {
    const persisted = this.sequenceResolver?.(localRunId) ?? 0;
    return Math.max(persisted, stream?.latest_seq ?? 0);
  }

  private getStream(localRunId: string): RunStream {
    let stream = this.streams.get(localRunId);
    if (!stream) {
      stream = { events: [], latest_seq: 0, dropped_before: 0 };
      this.streams.set(localRunId, stream);
    }
    return stream;
  }

  private toRunEnvelope(event: BufferedRunEvent): RunEventEnvelope {
    return {
      local_run_id: event.local_run_id,
      local_seq: event.local_seq,
      type: event.type,
      payload: event.payload,
      received_at: event.received_at,
    };
  }

  private toLegacyEnvelope(event: BufferedRunEvent): SSEEnvelope {
    return {
      event_id: event.legacy_event_id,
      seq: event.local_seq,
      timestamp: event.received_at,
      type: event.type,
      data: event.payload,
    };
  }

  private writeRunEvent(reply: FastifyReply, event: BufferedRunEvent): void {
    this.writeRaw(
      event.local_run_id,
      reply,
      `id: ${event.local_seq}\nevent: run.event\ndata: ${JSON.stringify(this.toRunEnvelope(event))}\n\n`,
    );
  }

  private writeControl(
    reply: FastifyReply,
    event: string,
    data: Record<string, unknown>,
  ): void {
    const localRunId =
      typeof data.local_run_id === "string" ? data.local_run_id : "";
    this.writeRaw(
      localRunId,
      reply,
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  }

  private writeRaw(
    localRunId: string,
    reply: FastifyReply,
    payload: string,
  ): void {
    try {
      const accepted = reply.raw.write(payload);
      if (accepted === false) {
        this.unsubscribe(localRunId, reply);
        reply.raw.end();
      }
    } catch {
      this.unsubscribe(localRunId, reply);
    }
  }

  private subscriptionCount(): number {
    let count = 0;
    for (const subscribers of this.clients.values()) count += subscribers.size;
    return count;
  }

  private bufferBytes(events: BufferedRunEvent[]): number {
    return events.reduce(
      (total, event) =>
        total +
        Buffer.byteLength(JSON.stringify(this.toRunEnvelope(event)), "utf8"),
      0,
    );
  }
}
