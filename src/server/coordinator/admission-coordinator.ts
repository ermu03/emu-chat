import { QueueRepository } from '../db/repositories/queue.repository.js';
import { RunRepository } from '../db/repositories/run.repository.js';
import { LeaseRepository } from '../db/repositories/lease.repository.js';
import { ConversationRepository } from '../db/repositories/conversation.repository.js';
import { HermesAdapter } from '../hermes/adapter.js';
import { SSEHub } from '../sse/sse-hub.js';
import { generateQueueItemId, generateRunId } from '../../shared/ids.js';
import {
  QueueItemNotFoundError,
  RunNotFoundError,
  InvalidStateTransitionError,
  HermesUnavailableError,
} from '../domain/errors.js';
import type { QueueItemEntity, RunEntity } from '../db/schema-types.js';

export interface EnqueueInput {
  conversation_id: string;
  client_request_id?: string;
  content: string;
  sender_type?: 'user' | 'system';
}

export class AdmissionCoordinator {
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly leaseHolder = `coordinator_${process.pid}`;

  constructor(
    private readonly queueRepo: QueueRepository,
    private readonly runRepo: RunRepository,
    private readonly leaseRepo: LeaseRepository,
    private readonly convRepo: ConversationRepository,
    private readonly hermesAdapter: HermesAdapter,
    private readonly sseHub: SSEHub
  ) {}

  /**
   * 启动后台轮询调度
   */
  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, 1000);
  }

  /**
   * 停止调度循环
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 消息排队入队
   */
  public async enqueueMessage(input: EnqueueInput): Promise<QueueItemEntity> {
    const conv = await this.convRepo.findById(input.conversation_id);
    if (!conv) {
      throw new QueueItemNotFoundError(`Conversation ${input.conversation_id} not found`);
    }

    const queueItemId = generateQueueItemId();
    const item = await this.queueRepo.enqueue({
      id: queueItemId,
      conversation_id: input.conversation_id,
      client_request_id: input.client_request_id,
      content: input.content,
      sender_type: input.sender_type || 'user',
    });

    // 广播入队事件
    this.sseHub.broadcast(input.conversation_id, 'queue.enqueued', {
      queue_item_id: item.id,
      position: item.sequence_number,
      client_request_id: item.client_request_id,
      created_at: item.created_at,
    });

    // 立即触发一次调度
    setImmediate(() => this.tick().catch(() => {}));

    return item;
  }

  /**
   * 取消指定的排队项
   */
  public async cancelQueueItem(conversationId: string, queueItemId: string): Promise<void> {
    const item = await this.queueRepo.findById(queueItemId);
    if (!item || item.conversation_id !== conversationId) {
      throw new QueueItemNotFoundError(`Queue item ${queueItemId} not found`);
    }

    if (item.status !== 'queued') {
      throw new InvalidStateTransitionError(
        `Cannot cancel queue item in state ${item.status}`
      );
    }

    await this.queueRepo.updateStatus(queueItemId, 'cancelled');

    this.sseHub.broadcast(conversationId, 'queue.cancelled', {
      queue_item_id: queueItemId,
    });
  }

  /**
   * 获取会话排队列表
   */
  public async getQueue(conversationId: string): Promise<QueueItemEntity[]> {
    return this.queueRepo.findQueuedByConversation(conversationId);
  }

  /**
   * 获取特定 Run 信息
   */
  public async getRun(conversationId: string, runId: string): Promise<RunEntity> {
    const run = await this.runRepo.findById(runId);
    if (!run || run.conversation_id !== conversationId) {
      throw new RunNotFoundError(`Run ${runId} not found`);
    }
    return run;
  }

  /**
   * 取消正在执行的 Run
   */
  public async cancelRun(conversationId: string, runId: string): Promise<void> {
    const run = await this.getRun(conversationId, runId);
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      return; // 已终态无需再次取消
    }

    if (run.hermes_run_id) {
      try {
        await this.hermesAdapter.cancelRun(run.hermes_run_id);
      } catch (err) {
        // 忽略可能已经结束的上游取消失败
      }
    }

    await this.runRepo.updateStatus(runId, 'cancelled');
    await this.queueRepo.updateStatus(run.queue_item_id, 'cancelled');
    await this.leaseRepo.releaseLease('conversation', conversationId, this.leaseHolder);

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
    decision: 'approve' | 'reject' | 'cancel'
  ): Promise<void> {
    const run = await this.getRun(conversationId, runId);
    if (run.status !== 'paused') {
      throw new InvalidStateTransitionError(`Run ${runId} is not paused (status: ${run.status})`);
    }

    if (decision === 'cancel') {
      await this.cancelRun(conversationId, runId);
      return;
    }

    if (run.hermes_run_id) {
      try {
        await this.hermesAdapter.submitApproval(run.hermes_run_id, decision);
      } catch (err) {
        throw new HermesUnavailableError(`Failed to forward approval to upstream: ${err}`);
      }
    }

    await this.runRepo.updateStatus(runId, 'running');
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
      // 遍历所有有排队项的会话
      const queuedItems = await this.queueRepo.findAllQueued();
      const distinctConvs = Array.from(new Set(queuedItems.map((q) => q.conversation_id)));

      for (const convId of distinctConvs) {
        await this.processConversationQueue(convId);
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
    const activeRuns = await this.runRepo.findActiveByConversation(conversationId);
    if (activeRuns.length > 0) {
      return; // 保证单会话同一时刻严格只运行一个 Run
    }

    // 尝试抢占会话租约（默认 30 秒有效）
    const acquired = await this.leaseRepo.acquireLease('conversation', conversationId, this.leaseHolder, 30);
    if (!acquired) {
      return; // 其它实例正在协调
    }

    const nextItem = await this.queueRepo.findNextQueued(conversationId);
    if (!nextItem) {
      await this.leaseRepo.releaseLease('conversation', conversationId, this.leaseHolder);
      return;
    }

    const conv = await this.convRepo.findById(conversationId);
    if (!conv || !conv.hermes_session_id) {
      await this.queueRepo.updateStatus(nextItem.id, 'failed', 'Missing hermes_session_id');
      await this.leaseRepo.releaseLease('conversation', conversationId, this.leaseHolder);
      return;
    }

    // 创建本地 Run 记录
    const runId = generateRunId();
    await this.runRepo.create({
      id: runId,
      conversation_id: conversationId,
      queue_item_id: nextItem.id,
      status: 'pending',
    });

    await this.queueRepo.updateStatus(nextItem.id, 'running');

    this.sseHub.broadcast(conversationId, 'run.started', {
      run_id: runId,
      queue_item_id: nextItem.id,
      created_at: new Date().toISOString(),
    });

    // 异步执行上游 Run 调度
    this.executeHermesRun(conversationId, conv.hermes_session_id, runId, nextItem).catch(async (err) => {
      await this.runRepo.updateStatus(runId, 'failed', String(err));
      await this.queueRepo.updateStatus(nextItem.id, 'failed', String(err));
      await this.leaseRepo.releaseLease('conversation', conversationId, this.leaseHolder);
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
        prompt: queueItem.content,
      });

      await this.runRepo.updateHermesRunId(runId, hermesRun.run_id);
      await this.runRepo.updateStatus(runId, 'running');

      // 订阅 upstream 事件流并转发至本地 SSEHub
      const stream = await this.hermesAdapter.streamEvents(hermesSessionId, hermesRun.run_id);
      for await (const event of stream) {
        if (event.type === 'tool_approval_required') {
          await this.runRepo.updateStatus(runId, 'paused', undefined, 'approval_required');
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

      // 执行完成终态收尾
      await this.runRepo.updateStatus(runId, 'succeeded');
      await this.queueRepo.updateStatus(queueItem.id, 'completed');
      this.sseHub.broadcast(conversationId, 'run.completed', {
        run_id: runId,
        queue_item_id: queueItem.id,
      });
    } finally {
      await this.leaseRepo.releaseLease('conversation', conversationId, this.leaseHolder);
    }
  }
}
