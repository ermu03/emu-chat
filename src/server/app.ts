import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { AppConfig } from './config.js';
import { logger } from './logging.js';
import { generateId, ID_PREFIXES } from '../shared/ids.js';
import { LIMITS } from '../shared/limits.js';
import { AppError, InternalError, InvalidRequestError } from './domain/errors.js';
import { ZodError } from 'zod';
import { createDatabase } from './db/connection.js';
import { DraftRepository, PreferencesRepository } from './db/repositories/conversation.repository.js';
import { QueueRepository } from './db/repositories/queue.repository.js';
import { RunRepository } from './db/repositories/run.repository.js';
import { HermesClient } from './hermes/client.js';
import { HermesAdapter } from './hermes/adapter.js';
import { StatusService } from './services/status-service.js';
import { ConversationService } from './services/conversation-service.js';
import { DraftPreferencesService } from './services/draft-preferences-service.js';
import { statusRoutes } from './http/routes/status.js';
import { conversationRoutes } from './http/routes/conversations.js';
import { draftPreferencesRoutes } from './http/routes/drafts-and-preferences.js';

export interface ServerDependencies {
  db?: Database.Database;
  hermesClient?: HermesClient;
  hermesAdapter?: HermesAdapter;
  statusService?: StatusService;
  conversationService?: ConversationService;
  draftPreferencesService?: DraftPreferencesService;
}

export function buildServer(
  config: AppConfig,
  dependencies: ServerDependencies = {}
): FastifyInstance {
  const server = Fastify({
    logger: false,
    bodyLimit: LIMITS.JSON_BODY_MAX_BYTES,
    genReqId: (req) => {
      const headerId = req.headers['x-request-id'];
      if (typeof headerId === 'string' && headerId.trim()) {
        return headerId.trim();
      }
      return generateId(ID_PREFIXES.request);
    }
  });

  // Attach Request-ID to response headers
  server.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Global Error Handler
  server.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id || generateId(ID_PREFIXES.request));

    if (error instanceof AppError) {
      logger.warn(`AppError: ${error.code} - ${error.message}`, {
        requestId,
        errorCode: error.code,
        upstreamStatus: error.upstreamStatus
      });
      reply.status(error.statusCode).send(error.toEnvelope(requestId));
      return;
    }

    if (error instanceof ZodError) {
      const invalidErr = new InvalidRequestError('Request validation failed', {
        issues: error.issues
      });
      logger.warn('Validation error', {
        requestId,
        errorCode: invalidErr.code,
        details: { issues: error.issues }
      });
      reply.status(400).send(invalidErr.toEnvelope(requestId));
      return;
    }

    // Fastify schema/validation error
    if (
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      const clientErr = new InvalidRequestError(error.message);
      reply.status(error.statusCode).send(clientErr.toEnvelope(requestId));
      return;
    }

    // Payload too large
    if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const payloadErr = new AppError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds allowable limit',
        statusCode: 413,
        retryable: false,
        action: 'none'
      });
      reply.status(413).send(payloadErr.toEnvelope(requestId));
      return;
    }

    logger.error('Unhandled internal server error', {
      requestId,
      details: {
        errorMessage: error.message,
        stack: error.stack
      }
    });

    const internalErr = new InternalError('Internal server error');
    reply.status(500).send(internalErr.toEnvelope(requestId));
  });

  // Wire dependencies
  const db = dependencies.db ?? createDatabase(config.sqlitePath);
  const convRepo = new ConversationRepository(db);
  const draftRepo = new DraftRepository(db);
  const queueRepo = new QueueRepository(db);
  const runRepo = new RunRepository(db);

  const hermesClient =
    dependencies.hermesClient ??
    new HermesClient({
      baseUrl: config.hermesBaseUrl,
      token: config.hermesToken,
      timeoutMs: config.hermesTimeoutMs
    });

  const hermesAdapter =
    dependencies.hermesAdapter ?? new HermesAdapter(hermesClient);

  const statusService =
    dependencies.statusService ??
    new StatusService(hermesAdapter, runRepo);

  const conversationService =
    dependencies.conversationService ??
    new ConversationService(
      hermesAdapter,
      convRepo,
      draftRepo,
      queueRepo,
      runRepo
    );

  const draftPreferencesService =
    dependencies.draftPreferencesService ??
    new DraftPreferencesService(draftRepo, new PreferencesRepository(db));

  // Register API Routes
  server.register(statusRoutes, {
    prefix: '/api/v1',
    statusService
  });

  server.register(conversationRoutes, {
    prefix: '/api/v1',
    conversationService
  });

  server.register(draftPreferencesRoutes, {
    prefix: '/api/v1',
    draftPreferencesService
  });

  // Serve static client in production
  if (config.isProduction) {
    const clientDist = path.resolve(process.cwd(), 'dist/client');
    if (fs.existsSync(clientDist)) {
      server.register(fastifyStatic, {
        root: clientDist,
        prefix: '/'
      });

      // SPA fallback
      server.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/')) {
          reply.status(404).send({
            error: {
              code: 'LOCAL_NOT_FOUND',
              message: 'API route not found',
              retryable: false,
              action: 'none',
              request_id: request.id
            }
          });
          return;
        }
        reply.sendFile('index.html');
      });
    }
  }

  return server;
}
