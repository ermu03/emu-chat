import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  CreateConversationRequestSchema,
  DeleteConversationRequestSchema,
  ForkConversationRequestSchema,
  GetConversationsQuerySchema,
  GetMessagesQuerySchema,
  PatchHermesMetadataRequestSchema,
  PatchLocalMetadataRequestSchema,
  ResetConversationRequestSchema
} from '../../shared/api-schemas.js';
import { ValidationError } from '../domain/errors.js';
import type { ConversationService } from '../../services/conversation-service.js';

export interface ConversationRoutesOptions {
  conversationService: ConversationService;
}

export const conversationRoutes: FastifyPluginAsync<ConversationRoutesOptions> = async (
  fastify: FastifyInstance,
  options: ConversationRoutesOptions
) => {
  const { conversationService } = options;

  fastify.get('/conversations', async (req, reply) => {
    const parseResult = GetConversationsQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid conversations query: ${parseResult.error.message}`
      );
    }
    const res = await conversationService.listConversations(parseResult.data);
    return reply.status(200).send(res);
  });

  fastify.post('/conversations', async (req, reply) => {
    const parseResult = CreateConversationRequestSchema.safeParse(req.body ?? {});
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid create conversation payload: ${parseResult.error.message}`
      );
    }
    const res = await conversationService.createConversation(parseResult.data);
    return reply.status(201).send(res);
  });

  fastify.get('/conversations/:conversationId', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const res = await conversationService.getConversation(conversationId);
    return reply.status(200).send(res);
  });

  fastify.get('/conversations/:conversationId/messages', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const parseResult = GetMessagesQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid messages query: ${parseResult.error.message}`
      );
    }
    const res = await conversationService.getMessages(conversationId, parseResult.data);
    return reply.status(200).send(res);
  });

  fastify.patch('/conversations/:conversationId/hermes-metadata', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const parseResult = PatchHermesMetadataRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid hermes-metadata payload: ${parseResult.error.message}`
      );
    }
    const res = await conversationService.updateHermesMetadata(conversationId, parseResult.data);
    return reply.status(200).send(res);
  });

  fastify.patch('/conversations/:conversationId/local-metadata', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const parseResult = PatchLocalMetadataRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid local-metadata payload: ${parseResult.error.message}`
      );
    }
    const res = await conversationService.updateLocalMetadata(conversationId, parseResult.data);
    return reply.status(200).send(res);
  });

  fastify.post('/conversations/:conversationId/fork', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const parseResult = ForkConversationRequestSchema.safeParse(req.body ?? {});
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid fork conversation payload: ${parseResult.error.message}`
      );
    }
    const res = await conversationService.forkConversation(conversationId, parseResult.data);
    return reply.status(201).send(res);
  });

  fastify.post('/conversations/:conversationId/reset', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const parseResult = ResetConversationRequestSchema.safeParse(req.body ?? {});
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid reset conversation payload: ${parseResult.error.message}`
      );
    }
    const res = await conversationService.resetConversation(conversationId, parseResult.data);
    return reply.status(201).send(res);
  });

  fastify.post('/conversations/:conversationId/delete', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const parseResult = DeleteConversationRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid delete conversation payload: ${parseResult.error.message}`
      );
    }
    const res = await conversationService.deleteConversation(conversationId, parseResult.data);
    return reply.status(200).send(res);
  });
};
