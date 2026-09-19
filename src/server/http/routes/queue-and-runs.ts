import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AdmissionCoordinator } from '../../coordinator/admission-coordinator.js';
import type { SSEHub } from '../../sse/sse-hub.js';
import { InvalidRequestError } from '../../domain/errors.js';
import { generateClientRequestId } from '../../shared/ids.js';

const EnqueueMessageBodySchema = z.object({
  client_request_id: z.string().optional(),
  text: z.string().min(1).max(65536),
});

const ApprovalBodySchema = z.object({
  decision: z.enum(['once', 'always', 'reject']),
});

export const queueAndRunsRoutes: FastifyPluginAsync<{
  coordinator: AdmissionCoordinator;
  sseHub: SSEHub;
}> = async (fastify, opts) => {
  const { coordinator, sseHub } = opts;

  // 1. 发送/入队消息 POST /conversations/:id/messages
  fastify.post<{
    Params: { id: string };
  }>('/conversations/:id/messages', async (req, reply) => {
    const parsed = EnqueueMessageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InvalidRequestError(parsed.error.message);
    }

    const clientRequestId = parsed.data.client_request_id || generateClientRequestId();
    const item = await coordinator.enqueueMessage({
      conversation_id: req.params.id,
      client_request_id: clientRequestId,
      text: parsed.data.text,
    });

    return reply.status(202).send({
      data: item,
    });
  });

  // 2. 查看会话当前排队状态 GET /conversations/:id/queue
  fastify.get<{
    Params: { id: string };
  }>('/conversations/:id/queue', async (req, reply) => {
    const queue = await coordinator.getQueue(req.params.id);
    return reply.send({
      data: queue,
    });
  });

  // 3. 取消排队中的消息 DELETE /conversations/:id/queue/:itemId
  fastify.delete<{
    Params: { id: string; itemId: string };
  }>('/conversations/:id/queue/:itemId', async (req, reply) => {
    await coordinator.cancelQueueItem(req.params.id, req.params.itemId);
    return reply.status(204).send();
  });

  // 4. 查看 Run 状态 GET /conversations/:id/runs/:runId
  fastify.get<{
    Params: { id: string; runId: string };
  }>('/conversations/:id/runs/:runId', async (req, reply) => {
    const run = await coordinator.getRun(req.params.id, req.params.runId);
    return reply.send({
      data: run,
    });
  });

  // 5. 取消 Run POST /conversations/:id/runs/:runId/cancel
  fastify.post<{
    Params: { id: string; runId: string };
  }>('/conversations/:id/runs/:runId/cancel', async (req, reply) => {
    await coordinator.cancelRun(req.params.id, req.params.runId);
    return reply.status(202).send({
      data: { status: 'cancelling' },
    });
  });

  // 6. 提交工具调用/交互审批 POST /conversations/:id/runs/:runId/approval
  fastify.post<{
    Params: { id: string; runId: string };
  }>('/conversations/:id/runs/:runId/approval', async (req, reply) => {
    const parsed = ApprovalBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InvalidRequestError(parsed.error.message);
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

  // 7. 会话 SSE 事件流订阅 GET /conversations/:id/events
  fastify.get<{
    Params: { id: string };
    Headers: { 'last-event-id'?: string };
  }>('/conversations/:id/events', async (req, reply) => {
    const lastEventId = req.headers['last-event-id'];
    sseHub.subscribe(req.params.id, reply, lastEventId);
  });
};
