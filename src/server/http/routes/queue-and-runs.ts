import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AdmissionCoordinator } from '../../coordinator/admission-coordinator.js';
import type { SSEHub } from '../../sse/sse-hub.js';
import { ValidationError } from '../../domain/errors.js';

const EnqueueMessageBodySchema = z.object({
  client_request_id: z.string().optional(),
  content: z.string().min(1).max(65536),
  sender_type: z.enum(['user', 'system']).default('user'),
});

const ApprovalBodySchema = z.object({
  decision: z.enum(['approve', 'reject', 'cancel']),
});

export const queueAndRunsRoutes: FastifyPluginAsync<{
  coordinator: AdmissionCoordinator;
  sseHub: SSEHub;
}> = async (fastify, opts) => {
  const { coordinator, sseHub } = opts;

  // 1. 发送/入队消息
  fastify.post<{
    Params: { id: string };
  }>('/conversations/:id/messages', async (req, reply) => {
    const parsed = EnqueueMessageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }

    const item = await coordinator.enqueueMessage({
      conversation_id: req.params.id,
      client_request_id: parsed.data.client_request_id,
      content: parsed.data.content,
      sender_type: parsed.data.sender_type,
    });

    return reply.status(202).send({
      data: item,
    });
  });

  // 2. 查看会话当前排队状态
  fastify.get<{
    Params: { id: string };
  }>('/conversations/:id/queue', async (req, reply) => {
    const queue = await coordinator.getQueue(req.params.id);
    return reply.send({
      data: queue,
    });
  });

  // 3. 取消排队中的消息
  fastify.delete<{
    Params: { id: string; itemId: string };
  }>('/conversations/:id/queue/:itemId', async (req, reply) => {
    await coordinator.cancelQueueItem(req.params.id, req.params.itemId);
    return reply.status(204).send();
  });

  // 4. 查看 Run 状态
  fastify.get<{
    Params: { id: string; runId: string };
  }>('/conversations/:id/runs/:runId', async (req, reply) => {
    const run = await coordinator.getRun(req.params.id, req.params.runId);
    return reply.send({
      data: run,
    });
  });

  // 5. 取消 Run
  fastify.post<{
    Params: { id: string; runId: string };
  }>('/conversations/:id/runs/:runId/cancel', async (req, reply) => {
    await coordinator.cancelRun(req.params.id, req.params.runId);
    return reply.status(202).send({
      data: { status: 'cancelling' },
    });
  });

  // 6. 提交工具调用/交互审批
  fastify.post<{
    Params: { id: string; runId: string };
  }>('/conversations/:id/runs/:runId/approval', async (req, reply) => {
    const parsed = ApprovalBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }

    await coordinator.submitApproval(
      req.params.id,
      req.params.runId,
      parsed.data.decision
    );

    return reply.send({
      data: { status: 'submitted' },
    });
  });

  // 7. 会话 SSE 事件流订阅
  fastify.get<{
    Params: { id: string };
    Headers: { 'last-event-id'?: string };
  }>('/conversations/:id/events', async (req, reply) => {
    const lastEventId = req.headers['last-event-id'];
    sseHub.subscribe(req.params.id, reply, lastEventId);
  });
};
