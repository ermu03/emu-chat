import { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface FakeHermesConfig {
  detailedHealthResponse?: Record<string, unknown>;
  sessions?: Map<string, { id: string; title: string; messages: any[] }>;
  failNextRun?: boolean;
  pauseNextRun?: boolean;
  simulateDisconnect?: boolean;
}

/**
 * 内存级 Fake Hermes 协议与故障注入服务器
 */
export class FakeHermesServer extends EventEmitter {
  private sessions: Map<string, { id: string; title: string; messages: any[] }> = new Map();
  private runs: Map<string, { id: string; sessionId: string; status: string }> = new Map();
  public failNextRun = false;
  public pauseNextRun = false;
  public simulateDisconnect = false;

  constructor() {
    super();
    // 默认空会话
    this.sessions.set('ses_test_1', {
      id: 'ses_test_1',
      title: '测试会话 1',
      messages: [
        {
          id: 'msg_1',
          role: 'user',
          content: '你好 Hermes',
          created_at: '2026-03-30T10:00:00Z'
        },
        {
          id: 'msg_2',
          role: 'assistant',
          content: '你好！我是模拟的 Hermes。',
          created_at: '2026-03-30T10:00:01Z'
        }
      ]
    });
  }

  public getHealth() {
    return {
      status: 'ok',
      version: '0.9.0',
      active_agents: 0,
      capabilities: {
        streaming: true,
        runs_cancel: true,
        runs_pause_resume: true,
        session_fork: true,
        session_reset: true,
        session_title_update: true,
        session_delete: true,
        multi_segment_history: true
      },
      runs_idempotency: true,
      durable: true,
      retention_seconds: 86400,
      execution_mode: 'local'
    };
  }

  public listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      title: s.title,
      created_at: '2026-03-30T10:00:00Z',
      updated_at: '2026-03-30T10:00:00Z'
    }));
  }

  public getSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      id: s.id,
      title: s.title,
      created_at: '2026-03-30T10:00:00Z',
      updated_at: '2026-03-30T10:00:00Z',
      current_segment_id: 'seg_1'
    };
  }

  public getMessages(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return s.messages;
  }

  public startRun(sessionId: string, input: string) {
    if (this.failNextRun) {
      this.failNextRun = false;
      throw new Error('Hermes 模拟故障: 无法创建 Run');
    }

    const runId = `run_${Date.now()}`;
    const initialStatus = this.pauseNextRun ? 'paused' : 'running';
    if (this.pauseNextRun) {
      this.pauseNextRun = false;
    }

    this.runs.set(runId, { id: runId, sessionId, status: initialStatus });

    // 记录用户消息到 session
    const s = this.sessions.get(sessionId);
    if (s) {
      s.messages.push({
        id: `msg_in_${Date.now()}`,
        role: 'user',
        content: input,
        created_at: new Date().toISOString()
      });
    }

    return {
      run_id: runId,
      session_id: sessionId,
      status: initialStatus,
      pause_reason: initialStatus === 'paused' ? 'tool_approval' : undefined,
      pause_metadata: initialStatus === 'paused' ? { tool: 'shell_exec', command: 'rm -rf /' } : undefined
    };
  }

  public getRun(runId: string) {
    return this.runs.get(runId) || null;
  }

  public submitApproval(runId: string, decision: string) {
    const r = this.runs.get(runId);
    if (!r) throw new Error('Run 不存在');
    if (decision === 'approve') {
      r.status = 'completed';
      const s = this.sessions.get(r.sessionId);
      if (s) {
        s.messages.push({
          id: `msg_out_${Date.now()}`,
          role: 'assistant',
          content: '工具调用已批准并执行完毕。',
          created_at: new Date().toISOString()
        });
      }
    } else {
      r.status = 'cancelled';
    }
    return { run_id: runId, status: r.status };
  }
}
