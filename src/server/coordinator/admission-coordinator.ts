import { generateOperationId, generateQueueItemId, generateRunId } from '../../shared/ids.js';
import { QueueRepository } from '../db/repositories/queue.repository.js';
import { RunRepository } from '../db/repositories/run.repository.js';
import { LeaseRepository } from '../db/repositories/lease.repository.js';
import { ConversationRepository } from '../db/repositories/conversation.repository.js';
import { HermesAdapter } from '../hermes/adapter.js';
import { SSEHub } from '../sse/sse-hub.js';
import {
  LocalNotFoundError,
  StateConflictError,
  HermesUnavailableError,
  QueueFullError,
  ApprovalNotPendingError
} from '../domain/errors.js';
import { QueueItemEntity, RunEntity } from '../db/schema-types.js';

export class AdmissionCoordinator {
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly leaseHolder = `coordinator_${process.pid}`;

  constructor(
    private queueRepo: QueueRepository,
    private runRepo: RunRepository,
    private leaseRepo: LeaseRepository,
    private convRepo: ConversationRepository,
    private hermesAdapter: HermesAdapter,
    private sseHub: SSEHub
  ) {}

  public start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[AdmissionCoordinator] tick error:', err);
      });
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 提交消息入队
   */
  public async enqueueMessage(input: {
    conversation_id: string;
    client_request_id: string;
    text: string;
  }): Promise<{ queue_item_id: string; operation_id: string; position: number }> {
    const conv = this.convRepo.findById(input.conversation_id);
    if (!conv) {
      throw new LocalNotFoundError(`Conversation ${input.conversation_id} not found`);
    }

    const item = this.queueRepo.enqueue({
      id: generateQueueItemId(),
      conversation_id: input.conversation_id,
      operation_id: generateOperationId(),
      client_request_id: input.client_request_id,
      payload_text: input.text,
      idempotency_key: input.client_request_id,
    });

    const queuedItems = this.queueRepo.listByConversation(input.conversation_id);
    const position = queuedItems.findIndex((q) => q.id === item.id) + 1;

    this.sseHub.broadcast(input.conversation_id, 'queue.enqueued', {
      queue_item_id: item.id,
      position,
    });

    return {
      queue_item_id: item.id,
      operation_id: item.operation_id,
      position,
    };
  }

  /**
   * 取消指定的排队项
   */
  public async cancelQueueItem(conversationId: string, queueItemId: string): Promise<void> {
    const item = this.queueRepo.findById(queueItemId);
    if (!item || item.conversation_id !== conversationId) {
      throw new LocalNotFoundError(`Queue item ${queueItemId} not found`);
    }

    if (item.state !== 'queued') {
      throw new StateConflictError(
        `Cannot cancel queue item in state ${item.state}`
      );
    }

    this.queueRepo.updateState(queueItemId, item.revision, {
      state: 'cancelled',
      terminal: true,
    });

    this.sseHub.broadcast(conversationId, 'queue.cancelled', {
      queue_item_id: queueItemId,
    });
  }

  /**
   * 获取会话排队列表
   */
  public async getQueue(conversationId: string): Promise<QueueItemEntity[]> {
    return this.queueRepo.listByConversation(conversationId);
  }

  /**
   * 获取特定 Run 信息
   */
  public async getRun(conversationId: string, runId: string): Promise<RunEntity> {
    const run = this.runRepo.findById(runId);
    if (!run || run.conversation_id !== conversationId) {
      throw new LocalNotFoundError(`Run ${runId} not found`);
    }
    return run;
  }

  /**
   * 取消正在执行的 Run
   */
  public async cancelRun(conversationId: string, runId: string): Promise<void> {
    const run = await this.getRun(conversationId, runId);
    if (['rejected', 'reconciled'].includes(run.local_state)) {
      return; // 已终态无需再次取消
    }

    if (run.hermes_run_id) {
      try {
        await this.hermesAdapter.cancelRun(run.hermes_run_id);
      } catch (err) {
        // 忽略可能已经结束的上游取消失败
      }
    }

    this.runRepo.update(runId, {
      local_state: 'rejected',
      terminal: true,
      last_error_code: 'CANCELLED',
    });

    const queueItem = this.queueRepo.findById(run.queue_item_id);
    if (queueItem && queueItem.state !== 'cancelled' && queueItem.state !== 'done') {
      this.queueRepo.updateState(queueItem.id, queueItem.revision, {
        state: 'cancelled',
        terminal: true,
      });
    }

    this.leaseRepo.release('conversation', conversationId, this.leaseHolder);

    this.sseHub.broadcast(conversationId, 'run.cancelled', {
      run_id: runId,
      queue_item_id: run.queue_item_id,
    });
  }

  /**
   * 提交审批决定
   */
  public async submitApproval(
    conversationId: string,
    runId: string,
    decision: 'once' | 'always' | 'reject'
  ): Promise<void> {
    const run = await this.getRun(conversationId, runId);
    if (run.upstream_status !== 'waiting_for_approval') {
      throw new ApprovalNotPendingError(`Run ${runId} is not paused waiting for approval`);
    }

    if (run.hermes_run_id) {
      try {
        await this.hermesAdapter.submitApproval(run.hermes_run_id, decision);
      } catch (err) {
        throw new HermesUnavailableError(`Failed to forward approval to upstream: ${err}`);
      }
    }

    this.runRepo.update(runId, {
      upstream_status: 'running',
    });

    this.sseHub.broadcast(conversationId, 'run.resumed', {
      run_id: runId,
      decision,
    });
  }

  /**
   * 核心调度逻辑
   */
  public async tick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 遍历所有待处理队列
      const activeGlobal = this.queueRepo.findActiveGlobal();
      if (activeGlobal) {
        await this.processConversationQueue(activeGlobal.conversation_id);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 处理单会话的排队与准入
   */
  private async processConversationQueue(conversationId: string): Promise<void> {
    // 检查会话当前是否有未完成的 Run
    const activeRun = this.runRepo.findActiveByConversation(conversationId);
    if (activeRun) {
      return; // 保证单会话同一时刻严格只运行一个 Run
    }

    // 尝试抢占会话租约（默认 30 秒有效）
    const expiresAt = new Date(Date.now() + 30 * 1000).toISOString();
    const acquired = this.leaseRepo.acquire(
      'conversation',
      conversationId,
      this.leaseHolder,
      `lease_${Date.now()}`,
      expiresAt
    );
    if (!acquired) {
      return; // 其它实例正在协调
    }

    const nextItem = this.queueRepo.findNextQueued(conversationId);
    if (!nextItem) {
      this.leaseRepo.release('conversation', conversationId, this.leaseHolder);
      return;
    }

    const conv = this.convRepo.findById(conversationId);
    if (!conv || !conv.hermes_session_id) {
      this.queueRepo.updateState(nextItem.id, nextItem.revision, {
        state: 'rejected',
        terminal: true,
        last_error_code: 'MISSING_HERMES_SESSION',
      });
      this.leaseRepo.release('conversation', conversationId, this.leaseHolder);
      return;
    }

    // 创建本地 Run 记录
    const runId = generateRunId();
    const run = this.runRepo.insert({
      id: runId,
      queue_item_id: nextItem.id,
      conversation_id: conversationId,
      local_state: 'submitting',
      upstream_status: 'queued',
      hermes_run_id: null,
    });

    this.queueRepo.updateState(nextItem.id, nextItem.revision, {
      state: 'dispatching',
      dispatch_session_id: conv.hermes_session_id,
    });

    this.sseHub.broadcast(conversationId, 'run.started', {
      run_id: runId,
      queue_item_id: nextItem.id,
      created_at: run.created_at,
    });

    // 异步执行上游 Run 调度
    this.executeHermesRun(conversationId, conv.hermes_session_id, runId, nextItem).catch(async (err) => {
      this.runRepo.update(runId, {
        local_state: 'rejected',
        terminal: true,
        last_error_code: String(err),
      });
      const currentItem = this.queueRepo.findById(nextItem.id);
      if (currentItem) {
        this.queueRepo.updateState(currentItem.id, currentItem.revision, {
          state: 'rejected',
          terminal: true,
          last_error_code: String(err),
        });
      }
      this.leaseRepo.release('conversation', conversationId, this.leaseHolder);
      this.sseHub.broadcast(conversationId, 'run.failed', {
        run_id: runId,
        error: String(err),
      });
    });
  }

  /**
   * 向上游触发执行并转播流式事件
   */
  private async executeHermesRun(
    conversationId: string,
    hermesSessionId: string,
    runId: string,
    queueItem: QueueItemEntity
  ): Promise<void> {
    try {
      const hermesRun = await this.hermesAdapter.startRun(hermesSessionId, {
        prompt: queueItem.payload_text || '',
      });

      this.runRepo.update(runId, {
        hermes_run_id: hermesRun.run_id,
        local_state: 'accepted',
        upstream_status: 'running',
      });

      const currentItem = this.queueRepo.findById(queueItem.id);
      if (currentItem) {
        this.queueRepo.updateState(currentItem.id, currentItem.revision, {
          state: 'accepted',
        });
      }

      // 订阅 upstream 事件流并转发至本地 SSEHub
      const stream = await this.hermesAdapter.streamEvents(hermesSessionId, hermesRun.run_id);
      for await (const event of stream) {
        if (event.type === 'tool_approval_required') {
          this.runRepo.update(runId, {
            upstream_status: 'waiting_for_approval',
          });
          this.sseHub.broadcast(conversationId, 'run.paused', {
            run_id: runId,
            reason: 'approval_required',
            details: event.data,
          });
        } else {
          this.sseHub.broadcast(conversationId, event.type, {
            run_id: runId,
            ...event.data,
          });
        }
      }

      this.runRepo.update(runId, {
        local_state: 'reconciled',
        upstream_status: 'completed',
        terminal: true,
      });

      const finishedItem = this.queueRepo.findById(queueItem.id);
      if (finishedItem) {
        this.queueRepo.updateState(finishedItem.id, finishedItem.revision, {
          state: 'done',
          terminal: true,
        });
      }

      this.leaseRepo.release('conversation', conversationId, this.leaseHolder);

      this.sseHub.broadcast(conversationId, 'run.completed', {
        run_id: runId,
        queue_item_id: queueItem.id,
      });
    } catch (err) {
      this.runRepo.update(runId, {
        local_state: 'rejected',
        upstream_status: 'failed',
        terminal: true,
        last_error_code: String(err),
      });

      const failedItem = this.queueRepo.findById(queueItem.id);
      if (failedItem) {
        this.queueRepo.updateState(failedItem.id, failedItem.revision, {
          state: 'rejected',
          terminal: true,
          last_error_code: String(err),
        });
      }

      this.leaseRepo.release('conversation', conversationId, this.leaseHolder);

      this.sseHub.broadcast(conversationId, 'run.failed', {
        run_id: runId,
        error: String(err),
      });
    }
  }
}