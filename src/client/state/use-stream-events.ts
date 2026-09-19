import { useState, useEffect, useRef, useCallback } from 'react';
import type { StreamEventEnvelope } from '../../shared/hermes-schemas.js';

export interface UseStreamEventsOptions {
  conversationId: string | null;
  onEvent?: (event: StreamEventEnvelope) => void;
  onError?: (err: Event) => void;
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
 * SSE 流事件订阅 Hook
 * 支持基于 Last-Event-ID 的断线重放与指数退避自动重连
 */
export function useStreamEvents({
  conversationId,
  onEvent,
  onError,
  enabled = true
}: UseStreamEventsOptions): StreamEventsState {
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const lastEventIdRef = useRef<string | null>(null);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
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
    if (!conversationId || !enabled) return;

    // 构建带 Last-Event-ID 或 query 参数的 SSE 地址
    let url = `/api/v1/conversations/${encodeURIComponent(conversationId)}/events`;
    if (lastEventIdRef.current) {
      url += `?last_event_id=${encodeURIComponent(lastEventIdRef.current)}`;
    }

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      setIsReconnecting(false);
      setError(null);
      reconnectAttemptsRef.current = 0;
    };

    es.onmessage = (e) => {
      try {
        if (e.lastEventId) {
          lastEventIdRef.current = e.lastEventId;
          setLastEventId(e.lastEventId);
        }
        const data = JSON.parse(e.data) as StreamEventEnvelope;
        onEvent?.(data);
      } catch (err) {
        // 忽略保活注释或心跳解析
      }
    };

    es.onerror = (e) => {
      onError?.(e);
      setIsConnected(false);
      es.close();
      eventSourceRef.current = null;

      // 指数退避重连
      reconnectAttemptsRef.current += 1;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 15000);
      setIsReconnecting(true);
      setError(`连接中断，将在 ${Math.round(delay / 1000)} 秒后重试...`);

      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    };
  }, [conversationId, enabled, onEvent, onError, disconnect]);

  useEffect(() => {
    if (conversationId && enabled) {
      connect();
    } else {
      disconnect();
    }
    return () => {
      disconnect();
    };
  }, [conversationId, enabled, connect, disconnect]);

  return {
    isConnected,
    isReconnecting,
    lastEventId,
    error,
    connect,
    disconnect
  };
}
