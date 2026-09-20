import { useCallback, useEffect, useRef, useState } from "react";

export interface RunStreamEvent {
  event: "stream.ready" | "run.event" | "stream.gap";
  data: Record<string, unknown>;
  id?: string;
}

export interface UseStreamEventsOptions {
  localRunId: string | null;
  onEvent?: (event: RunStreamEvent) => void;
  onError?: (error: Event) => void;
  enabled?: boolean;
}

export interface StreamEventsState {
  isConnected: boolean;
  isReconnecting: boolean;
  lastEventId: string | null;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
}

/**
 * Browser subscription for the run-keyed EventHub stream. EventSource sends
 * Last-Event-ID on native reconnects; this hook also includes `after` when it
 * creates a fresh connection after a transport failure.
 */
export function useStreamEvents({
  localRunId,
  onEvent,
  onError,
  enabled = true,
}: UseStreamEventsOptions): StreamEventsState {
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const lastEventIdRef = useRef<string | null>(null);
  const connectionGenerationRef = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onEventRef.current = onEvent;
    onErrorRef.current = onError;
  }, [onError, onEvent]);

  const disconnect = useCallback(() => {
    connectionGenerationRef.current += 1;
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsConnected(false);
    setIsReconnecting(false);
  }, []);

  const connect = useCallback(() => {
    disconnect();
    if (!localRunId || !enabled) return;

    const generation = connectionGenerationRef.current;
    const params = new URLSearchParams();
    if (lastEventIdRef.current !== null) {
      params.set("after", lastEventIdRef.current);
    }
    const query = params.toString();
    const source = new EventSource(
      `/api/v1/runs/${encodeURIComponent(localRunId)}/events${query ? `?${query}` : ""}`,
    );
    eventSourceRef.current = source;

    const receive =
      (eventName: RunStreamEvent["event"]) => (rawEvent: Event) => {
        if (connectionGenerationRef.current !== generation) return;
        const event = rawEvent as MessageEvent<string>;
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (!isRecord(parsed))
            throw new Error("SSE payload is not an object");

          const id = event.lastEventId || undefined;
          const localSeq =
            eventName === "run.event" && typeof parsed.local_seq === "number"
              ? parsed.local_seq
              : id === undefined
                ? null
                : Number(id);
          if (
            localSeq !== null &&
            Number.isInteger(localSeq) &&
            localSeq >= 0
          ) {
            const nextId = String(localSeq);
            lastEventIdRef.current = nextId;
            setLastEventId(nextId);
          }

          onEventRef.current?.({
            event: eventName,
            data: parsed,
            ...(id ? { id } : {}),
          });
        } catch {
          setError("收到无法解析的运行事件");
        }
      };

    source.addEventListener("stream.ready", receive("stream.ready"));
    source.addEventListener("run.event", receive("run.event"));
    source.addEventListener("stream.gap", receive("stream.gap"));
    source.onopen = () => {
      if (connectionGenerationRef.current !== generation) return;
      reconnectAttemptsRef.current = 0;
      setIsConnected(true);
      setIsReconnecting(false);
      setError(null);
    };
    source.onerror = (event) => {
      if (connectionGenerationRef.current !== generation) return;
      onErrorRef.current?.(event);
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
      setIsConnected(false);

      reconnectAttemptsRef.current += 1;
      const delay = Math.min(
        1_000 * 2 ** (reconnectAttemptsRef.current - 1),
        15_000,
      );
      setIsReconnecting(true);
      setError(`运行事件连接中断，将在 ${Math.ceil(delay / 1_000)} 秒后重试`);
      reconnectTimeoutRef.current = window.setTimeout(() => {
        if (connectionGenerationRef.current === generation)
          connectRef.current();
      }, delay);
    };
  }, [disconnect, enabled, localRunId]);

  connectRef.current = connect;

  useEffect(() => {
    lastEventIdRef.current = null;
    setLastEventId(null);
    reconnectAttemptsRef.current = 0;
    if (localRunId && enabled) {
      connect();
    } else {
      disconnect();
    }
    return disconnect;
  }, [connect, disconnect, enabled, localRunId]);

  return {
    isConnected,
    isReconnecting,
    lastEventId,
    error,
    connect,
    disconnect,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
