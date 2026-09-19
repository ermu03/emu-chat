import type { FastifyReply } from 'fastify';

export interface SSEEnvelope {
  event_id: string;
  seq: number;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export class SSEHub {
  // conversation_id -> 客户端连接响应集
  private clients = new Map<string, Set<FastifyReply>>();
  // conversation_id -> 环形缓冲区 (固定最大 500 条)
  private buffers = new Map<string, SSEEnvelope[]>();
  // conversation_id -> 严格递增序列号
  private seqCounters = new Map<string, number>();

  private readonly maxBufferSize = 500;

  /**
   * 注册客户端到指定会话的 SSE 订阅
   */
  public subscribe(
    conversationId: string,
    reply: FastifyReply,
    lastEventId?: string
  ): void {
    if (!this.clients.has(conversationId)) {
      this.clients.set(conversationId, new Set());
    }
    this.clients.get(conversationId)!.add(reply);

    // 设置 SSE 头
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    // 发送初次建立连接注释
    reply.raw.write(': connected\n\n');

    // 处理 Last-Event-ID 重放
    if (lastEventId) {
      this.replayEvents(conversationId, reply, lastEventId);
    }

    // 监听客户端主动断开
    reply.raw.on('close', () => {
      this.unsubscribe(conversationId, reply);
    });
  }

  /**
   * 取消订阅
   */
  public unsubscribe(conversationId: string, reply: FastifyReply): void {
    const subs = this.clients.get(conversationId);
    if (subs) {
      subs.delete(reply);
      if (subs.size === 0) {
        this.clients.delete(conversationId);
      }
    }
  }

  /**
   * 广播并缓存会话流式事件
   */
  public broadcast(
    conversationId: string,
    type: string,
    data: Record<string, unknown>
  ): SSEEnvelope {
    const seq = (this.seqCounters.get(conversationId) || 0) + 1;
    this.seqCounters.set(conversationId, seq);

    const eventId = `ev_${conversationId}_${seq}`;
    const envelope: SSEEnvelope = {
      event_id: eventId,
      seq,
      timestamp: new Date().toISOString(),
      type,
      data,
    };

    // 写入会话环形缓冲区
    if (!this.buffers.has(conversationId)) {
      this.buffers.set(conversationId, []);
    }
    const buffer = this.buffers.get(conversationId)!;
    buffer.push(envelope);
    if (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }

    // 推送给已连接的客户端
    const subs = this.clients.get(conversationId);
    if (subs && subs.size > 0) {
      const payload = this.formatSSE(envelope);
      for (const reply of subs) {
        try {
          reply.raw.write(payload);
        } catch {
          // 连接写异常由 close 事件清理
        }
      }
    }

    return envelope;
  }

  /**
   * 重放 Last-Event-ID 之后的历史事件
   */
  private replayEvents(
    conversationId: string,
    reply: FastifyReply,
    lastEventId: string
  ): void {
    const buffer = this.buffers.get(conversationId);
    if (!buffer || buffer.length === 0) {
      return;
    }

    const lastIdx = buffer.findIndex((e) => e.event_id === lastEventId);
    const missed = lastIdx >= 0 ? buffer.slice(lastIdx + 1) : buffer;

    for (const event of missed) {
      reply.raw.write(this.formatSSE(event));
    }
  }

  /**
   * 格式化为标准 SSE 字符串
   */
  private formatSSE(envelope: SSEEnvelope): string {
    return `id: ${envelope.event_id}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
  }

  /**
   * 针对全部已连接客户端发送保活心跳
   */
  public sendHeartbeat(): void {
    for (const [, subs] of this.clients.entries()) {
      for (const reply of subs) {
        try {
          reply.raw.write(': keepalive\n\n');
        } catch {
          // 忽略异常
        }
      }
    }
  }

  /**
   * 清理指定会话的所有连接与缓冲区
   */
  public cleanup(conversationId: string): void {
    const subs = this.clients.get(conversationId);
    if (subs) {
      for (const reply of subs) {
        try {
          reply.raw.end();
        } catch {
          // 忽略
        }
      }
      this.clients.delete(conversationId);
    }
    this.buffers.delete(conversationId);
    this.seqCounters.delete(conversationId);
  }
}
