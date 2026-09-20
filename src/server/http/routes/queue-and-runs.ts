import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ApprovalRequestSchema,
  CancelQueueItemRequestSchema,
  CopyToDraftRequestSchema,
  EmptyObjectRequestSchema,
  GetQueueQuerySchema,
  PatchQueueItemRequestSchema,
  SendMessageRequestSchema,
} from "../../../shared/api-schemas.js";
import { InvalidRequestError } from "../../domain/errors.js";
import type { QueueRunService } from "../../services/queue-run-service.js";
import type { SSEHub } from "../../sse/sse-hub.js";

const AfterQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export interface QueueAndRunsRouteOptions {
  queueRunService: QueueRunService;
  sseHub: SSEHub;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidRequestError(message, { issues: result.error.issues });
  }
  return result.data;
}

export const queueAndRunsRoutes: FastifyPluginAsync<
  QueueAndRunsRouteOptions
> = async (fastify, opts) => {
  const { queueRunService, sseHub } = opts;

  fastify.post<{ Params: { conversation_id: string } }>(
    "/conversations/:conversation_id/messages",
    async (request, reply) => {
      const body = parse(
        SendMessageRequestSchema,
        request.body,
        "Invalid message submission payload",
      );
      const result = await queueRunService.sendMessage(
        request.params.conversation_id,
        body.client_request_id,
        body.expected_draft_revision,
      );
      return reply.status(202).send(result);
    },
  );

  fastify.get<{
    Params: { conversation_id: string };
    Querystring: { include_terminal?: string };
  }>("/conversations/:conversation_id/queue", async (request, reply) => {
    const query = parse(
      GetQueueQuerySchema,
      request.query,
      "Invalid queue query",
    );
    return reply
      .status(200)
      .send(
        queueRunService.getQueue(
          request.params.conversation_id,
          query.include_terminal,
        ),
      );
  });

  fastify.patch<{ Params: { queue_item_id: string } }>(
    "/queue-items/:queue_item_id",
    async (request, reply) => {
      const body = parse(
        PatchQueueItemRequestSchema,
        request.body,
        "Invalid queue item payload",
      );
      return reply
        .status(200)
        .send(
          queueRunService.patchQueueItem(request.params.queue_item_id, body),
        );
    },
  );

  fastify.post<{ Params: { queue_item_id: string } }>(
    "/queue-items/:queue_item_id/cancel",
    async (request, reply) => {
      const body = parse(
        CancelQueueItemRequestSchema,
        request.body,
        "Invalid queue cancel payload",
      );
      return reply
        .status(200)
        .send(
          queueRunService.cancelQueueItem(request.params.queue_item_id, body),
        );
    },
  );

  fastify.post<{ Params: { conversation_id: string } }>(
    "/conversations/:conversation_id/queue/resume",
    async (request, reply) => {
      parse(
        EmptyObjectRequestSchema,
        request.body ?? {},
        "Invalid queue resume payload",
      );
      return reply
        .status(200)
        .send(
          await queueRunService.resumeQueue(request.params.conversation_id),
        );
    },
  );

  fastify.post<{ Params: { queue_item_id: string } }>(
    "/queue-items/:queue_item_id/copy-to-draft",
    async (request, reply) => {
      const body = parse(
        CopyToDraftRequestSchema,
        request.body,
        "Invalid recovery copy payload",
      );
      return reply
        .status(200)
        .send(
          await queueRunService.copyToDraft(request.params.queue_item_id, body),
        );
    },
  );

  fastify.post<{ Params: { queue_item_id: string } }>(
    "/queue-items/:queue_item_id/discard-recovery",
    async (request, reply) => {
      parse(
        EmptyObjectRequestSchema,
        request.body ?? {},
        "Invalid recovery discard payload",
      );
      return reply
        .status(200)
        .send(queueRunService.discardRecovery(request.params.queue_item_id));
    },
  );

  fastify.get<{ Params: { local_run_id: string } }>(
    "/runs/:local_run_id",
    async (request, reply) => {
      return reply
        .status(200)
        .send(await queueRunService.getRun(request.params.local_run_id));
    },
  );

  fastify.post<{ Params: { local_run_id: string } }>(
    "/runs/:local_run_id/stop",
    async (request, reply) => {
      parse(
        EmptyObjectRequestSchema,
        request.body ?? {},
        "Invalid run stop payload",
      );
      return reply
        .status(202)
        .send(await queueRunService.stopRun(request.params.local_run_id));
    },
  );

  fastify.post<{ Params: { local_run_id: string } }>(
    "/runs/:local_run_id/approval",
    async (request, reply) => {
      const body = parse(
        ApprovalRequestSchema,
        request.body,
        "Invalid approval payload",
      );
      return reply
        .status(202)
        .send(
          await queueRunService.submitApproval(
            request.params.local_run_id,
            body,
          ),
        );
    },
  );

  fastify.post<{ Params: { local_run_id: string } }>(
    "/runs/:local_run_id/reconcile",
    async (request, reply) => {
      parse(
        EmptyObjectRequestSchema,
        request.body ?? {},
        "Invalid reconcile payload",
      );
      return reply
        .status(202)
        .send(await queueRunService.reconcile(request.params.local_run_id));
    },
  );

  fastify.get<{
    Params: { local_run_id: string };
    Querystring: { after?: string };
    Headers: { "last-event-id"?: string };
  }>("/runs/:local_run_id/events", async (request, reply) => {
    const query = parse(
      AfterQuerySchema,
      request.query,
      "Invalid event cursor",
    );
    const headerValue = request.headers["last-event-id"];
    const headerCursor =
      headerValue === undefined ? undefined : Number(headerValue);
    if (
      headerCursor !== undefined &&
      (!Number.isInteger(headerCursor) || headerCursor < 0)
    ) {
      throw new InvalidRequestError(
        "Last-Event-ID must be a non-negative integer",
      );
    }
    if (
      query.after !== undefined &&
      headerCursor !== undefined &&
      query.after !== headerCursor
    ) {
      throw new InvalidRequestError("after and Last-Event-ID must match");
    }
    const run = await queueRunService.getRun(request.params.local_run_id);
    const cursor = query.after ?? headerCursor;
    sseHub.subscribe(run.id, reply, cursor);
    reply.hijack();
  });
};
