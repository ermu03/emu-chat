import Fastify, { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { AppConfig } from "./config.js";
import { logger } from "./logging.js";
import { generateId, ID_PREFIXES, isValidPrefixedId } from "../shared/ids.js";
import { LIMITS } from "../shared/limits.js";
import {
  AppError,
  InternalError,
  InvalidRequestError,
} from "./domain/errors.js";
import { ZodError } from "zod";
import { createDatabase } from "./db/connection.js";
import {
  DraftRepository,
  PreferencesRepository,
} from "./db/repositories/conversation.repository.js";
import { ConversationRepository } from "./db/repositories/conversation.repository.js";
import { LeaseRepository } from "./db/repositories/lease.repository.js";
import { QueueRepository } from "./db/repositories/queue.repository.js";
import { RunRepository } from "./db/repositories/run.repository.js";
import { HermesClient } from "./hermes/client.js";
import { HermesAdapter } from "./hermes/adapter.js";
import { StatusService } from "./services/status-service.js";
import { ConversationService } from "./services/conversation-service.js";
import { DraftPreferencesService } from "./services/draft-preferences-service.js";
import { QueueRunService } from "./services/queue-run-service.js";
import { AdmissionCoordinator } from "./coordinator/admission-coordinator.js";
import { SSEHub } from "./sse/sse-hub.js";
import { statusRoutes } from "./http/routes/status.js";
import { conversationRoutes } from "./http/routes/conversations.js";
import { draftPreferencesRoutes } from "./http/routes/drafts-and-preferences.js";
import { queueAndRunsRoutes } from "./http/routes/queue-and-runs.js";

export interface ServerDependencies {
  db?: Database.Database;
  hermesClient?: HermesClient;
  hermesAdapter?: HermesAdapter;
  statusService?: StatusService;
  conversationService?: ConversationService;
  draftPreferencesService?: DraftPreferencesService;
  queueRunService?: QueueRunService;
}

export function buildServer(
  config: AppConfig,
  dependencies: ServerDependencies = {},
): FastifyInstance {
  const server = Fastify({
    logger: false,
    bodyLimit: LIMITS.JSON_BODY_MAX_BYTES,
    genReqId: (req) => {
      const headerId = req.headers["x-request-id"];
      if (
        typeof headerId === "string" &&
        isValidPrefixedId(headerId.trim(), ID_PREFIXES.request)
      ) {
        return headerId.trim();
      }
      return generateId(ID_PREFIXES.request);
    },
  });

  // Attach Request-ID to response headers
  server.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // Global Error Handler
  server.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id || generateId(ID_PREFIXES.request));

    if (error instanceof AppError) {
      logger.warn(`AppError: ${error.code} - ${error.message}`, {
        requestId,
        errorCode: error.code,
        ...(error.upstreamStatus === undefined
          ? {}
          : { upstreamStatus: error.upstreamStatus }),
      });
      reply.status(error.statusCode).send(error.toEnvelope(requestId));
      return;
    }

    if (error instanceof ZodError) {
      const invalidErr = new InvalidRequestError("Request validation failed", {
        issues: error.issues,
      });
      logger.warn("Validation error", {
        requestId,
        errorCode: invalidErr.code,
        details: { issues: error.issues },
      });
      reply.status(400).send(invalidErr.toEnvelope(requestId));
      return;
    }

    // Fastify schema/validation error
    const unknownError: {
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
      stack?: unknown;
    } =
      error !== null && typeof error === "object"
        ? (error as {
            statusCode?: unknown;
            code?: unknown;
            message?: unknown;
            stack?: unknown;
          })
        : {};
    const statusCode =
      typeof unknownError.statusCode === "number"
        ? unknownError.statusCode
        : undefined;

    // Payload too large
    if (
      statusCode === 413 ||
      unknownError.code === "FST_ERR_CTP_BODY_TOO_LARGE"
    ) {
      const payloadErr = new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "Request payload exceeds allowable limit",
        statusCode: 413,
        retryable: false,
        action: "none",
      });
      reply.status(413).send(payloadErr.toEnvelope(requestId));
      return;
    }

    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      const clientErr = new InvalidRequestError(
        typeof unknownError.message === "string"
          ? unknownError.message
          : "Invalid request",
      );
      reply.status(statusCode).send(clientErr.toEnvelope(requestId));
      return;
    }

    logger.error("Unhandled internal server error", {
      requestId,
      details: {
        errorMessage:
          error instanceof Error
            ? error.message
            : typeof unknownError.message === "string"
              ? unknownError.message
              : String(error),
        ...(typeof unknownError.stack === "string"
          ? { stack: unknownError.stack }
          : {}),
      },
    });

    const internalErr = new InternalError("Internal server error");
    reply.status(500).send(internalErr.toEnvelope(requestId));
  });

  // Wire dependencies
  const ownsDatabase = dependencies.db === undefined;
  const db = dependencies.db ?? createDatabase(config.sqliteDbPath);
  const convRepo = new ConversationRepository(db);
  const draftRepo = new DraftRepository(db);
  const queueRepo = new QueueRepository(db);
  const runRepo = new RunRepository(db);

  const hermesClient =
    dependencies.hermesClient ??
    new HermesClient({
      baseUrl: config.hermesBaseUrl,
      token: config.hermesApiKey,
    });

  const hermesAdapter =
    dependencies.hermesAdapter ?? new HermesAdapter(hermesClient);

  const statusService =
    dependencies.statusService ?? new StatusService(hermesAdapter);

  const conversationService =
    dependencies.conversationService ??
    new ConversationService(
      hermesAdapter,
      convRepo,
      draftRepo,
      queueRepo,
      runRepo,
    );

  const draftPreferencesService =
    dependencies.draftPreferencesService ??
    new DraftPreferencesService(draftRepo, new PreferencesRepository(db));

  const sseHub = new SSEHub();
  const leaseRepo = new LeaseRepository(db);
  sseHub.setRunSequenceResolver(
    (localRunId) => runRepo.findById(localRunId)?.last_event_seq ?? null,
  );
  sseHub.setEvictionHandler((localRunId) => {
    const run = runRepo.findById(localRunId);
    if (run && !run.events_truncated)
      runRepo.update(localRunId, { events_truncated: 1 });
  });
  const coordinator = new AdmissionCoordinator(
    queueRepo,
    runRepo,
    leaseRepo,
    convRepo,
    hermesAdapter,
    sseHub,
  );
  coordinator.start();

  const queueRunService =
    dependencies.queueRunService ??
    new QueueRunService({
      db,
      conversationRepo: convRepo,
      draftRepo,
      queueRepo,
      runRepo,
      leaseRepo,
      hermesAdapter,
      wakeCoordinator: () => coordinator.wake(),
      reconcileCoordinator: (localRunId) =>
        coordinator.reconcileRun(localRunId),
    });

  let coordinatorStopped = false;
  let sseHubClosed = false;
  const stopCoordinator = (): void => {
    if (coordinatorStopped) return;
    coordinatorStopped = true;
    coordinator.stop();
  };
  const closeSseHub = (): void => {
    if (sseHubClosed) return;
    sseHubClosed = true;
    sseHub.close();
  };

  // End long-lived streams before Fastify waits for the HTTP server to drain.
  server.addHook("preClose", async () => {
    stopCoordinator();
    closeSseHub();
  });

  server.addHook("onClose", async () => {
    stopCoordinator();
    closeSseHub();
    if (ownsDatabase && db.open) db.close();
  });

  // Register API Routes
  server.register(statusRoutes, {
    prefix: "/api/v1",
    statusService,
  });

  server.register(conversationRoutes, {
    prefix: "/api/v1",
    conversationService,
  });

  server.register(draftPreferencesRoutes, {
    prefix: "/api/v1",
    draftPreferencesService,
  });

  server.register(queueAndRunsRoutes, {
    prefix: "/api/v1",
    queueRunService,
    sseHub,
  });

  // Serve static client in production
  if (config.isProduction) {
    const clientDist = path.resolve(process.cwd(), "dist/client");
    if (fs.existsSync(clientDist)) {
      server.register(fastifyStatic, {
        root: clientDist,
        prefix: "/",
      });

      // SPA fallback
      server.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
          reply.status(404).send({
            error: {
              code: "LOCAL_NOT_FOUND",
              message: "API route not found",
              retryable: false,
              action: "none",
              request_id: request.id,
            },
          });
          return;
        }
        reply.sendFile("index.html");
      });
    }
  }

  return server;
}
