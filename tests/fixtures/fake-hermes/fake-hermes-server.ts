import Fastify, { type FastifyInstance } from "fastify";
import type { HermesMessageItem } from "../../../src/shared/hermes-schemas.js";

type UpstreamRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

interface FakeSession {
  id: string;
  title: string;
  pinned: boolean;
  parentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: HermesMessageItem[];
}

interface FakeSessionResponse {
  id: string;
  source: string;
  model: null;
  title: string;
  started_at: number;
  ended_at: null;
  message_count: number;
  parent_session_id: string | null;
  pinned: boolean;
  archived: boolean;
  hidden: boolean;
  has_system_prompt: boolean;
  has_model_config: boolean;
  last_active?: number;
  preview?: string;
}

interface FakeRun {
  id: string;
  sessionId: string;
  input: string;
  status: UpstreamRunStatus;
  partial: boolean;
  approval: {
    request_id: string;
    command: string;
    description: string;
    choices: string[];
  } | null;
  approvalDecision: "once" | "deny" | null;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

export interface FakeHermesFault {
  errorType: "network_error" | "server_error";
  message?: string;
}

/**
 * Stateful Hermes-compatible test double. It only runs on 127.0.0.1 and its
 * state is discarded when the test closes it.
 */
export class FakeHermesServer {
  public readonly sessions = new Map<string, FakeSession>();
  public failNextRun = false;
  public pauseNextRun = false;
  public simulateDisconnect = false;
  public activeAgents = 0;
  public baseUrl: string | null = null;

  private readonly runs = new Map<string, FakeRun>();
  private readonly idempotency = new Map<
    string,
    { fingerprint: string; runId: string }
  >();
  private readonly effectiveSessionOverrides = new Map<string, string>();
  private app: FastifyInstance | null = null;
  private nextSession = 1;
  private nextRun = 1;
  private nextMessage = 1;
  private fault: FakeHermesFault | null = null;

  constructor() {
    const session = this.createSession({
      title: "Test session",
      id: "ses_test_1",
    });
    session.messages.push(
      this.createMessage(session.id, "user", "Hello Hermes"),
      this.createMessage(session.id, "assistant", "Hello from Fake Hermes."),
    );
  }

  async start(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    this.app = Fastify({ logger: false });
    this.registerRoutes(this.app);
    this.baseUrl = await this.app.listen({ host: "127.0.0.1", port: 0 });
    return this.baseUrl;
  }

  async close(): Promise<void> {
    if (this.app) await this.app.close();
    this.app = null;
    this.baseUrl = null;
  }

  getHealth() {
    return {
      status: "ok",
      version: "0.21.3-test",
      readiness: { status: "ok", checks: {} },
      platform: "hermes-agent",
      gateway_state: "running",
      platforms: {},
      active_agents: this.activeAgents,
      gateway_busy: this.activeAgents > 0,
      gateway_drainable: this.activeAgents === 0,
      exit_reason: null,
      updated_at: new Date().toISOString(),
      pid: 1,
    };
  }

  getCapabilities() {
    return {
      object: "hermes.api_server.capabilities",
      platform: "hermes-agent",
      runtime: { mode: "server_agent", tool_execution: "server" },
      features: {
        run_submission: true,
        run_status: true,
        run_events_sse: true,
        run_stop: true,
        run_approval_response: true,
        session_resources: true,
        session_fork: true,
        tool_progress_events: true,
        approval_events: true,
        runs_idempotency: {
          supported: true,
          durable: true,
          retention_seconds: 86_400,
          header: "Idempotency-Key",
        },
      },
      endpoints: {
        health_detailed: { method: "GET", path: "/health/detailed" },
        session_create: { method: "POST", path: "/api/sessions" },
        session: { method: "GET", path: "/api/sessions/{session_id}" },
        session_update: {
          method: "PATCH",
          path: "/api/sessions/{session_id}",
        },
        session_delete: {
          method: "DELETE",
          path: "/api/sessions/{session_id}",
        },
        session_messages: {
          method: "GET",
          path: "/api/sessions/{session_id}/messages",
        },
        session_fork: {
          method: "POST",
          path: "/api/sessions/{session_id}/fork",
        },
        runs: { method: "POST", path: "/v1/runs" },
        run_status: { method: "GET", path: "/v1/runs/{run_id}" },
        run_events: { method: "GET", path: "/v1/runs/{run_id}/events" },
        run_approval: {
          method: "POST",
          path: "/v1/runs/{run_id}/approval",
        },
        run_stop: { method: "POST", path: "/v1/runs/{run_id}/stop" },
      },
    };
  }

  createSession(
    input: {
      title?: string;
      id?: string;
      parentSessionId?: string | null;
    } = {},
  ): FakeSession {
    const now = new Date().toISOString();
    const id = input.id ?? `ses_test_${this.nextSession++}`;
    const numericTestId = input.id?.match(/^ses_test_(\d+)$/);
    if (numericTestId?.[1]) {
      this.nextSession = Math.max(
        this.nextSession,
        Number(numericTestId[1]) + 1,
      );
    }
    const session: FakeSession = {
      id,
      title: input.title ?? "Untitled session",
      pinned: false,
      parentSessionId: input.parentSessionId ?? null,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): FakeSessionResponse | null {
    const session = this.sessions.get(id);
    return session ? this.toSessionResponse(session) : null;
  }

  getMessages(sessionId: string): HermesMessageItem[] | null {
    const session = this.sessions.get(sessionId);
    return session ? [...session.messages] : null;
  }

  setEffectiveSessionIdForMessages(
    requestedSessionId: string,
    effectiveSessionId: string,
  ): void {
    this.effectiveSessionOverrides.set(requestedSessionId, effectiveSessionId);
  }

  simulateFault(fault: FakeHermesFault): void {
    this.fault = fault;
  }

  clearFault(): void {
    this.fault = null;
  }

  completeApprovalRun(runId: string): void {
    const run = this.requireRun(runId);
    if (run.status !== "running" || !run.approvalDecision) {
      throw new Error("Approval run is not awaiting completion");
    }
    if (run.approvalDecision === "once") {
      run.status = "completed";
      run.events = [{ type: "run.completed", data: { run_id: run.id } }];
      this.appendAssistantResult(run, "Tool approval completed.");
    } else {
      run.status = "cancelled";
      run.events = [{ type: "run.cancelled", data: { run_id: run.id } }];
    }
    run.approvalDecision = null;
  }

  completeStoppedRun(runId: string): void {
    const run = this.requireRun(runId);
    if (run.status !== "stopping") {
      throw new Error("Stopped run is not awaiting completion");
    }
    run.status = "cancelled";
    run.events = [{ type: "run.cancelled", data: { run_id: run.id } }];
  }

  private registerRoutes(app: FastifyInstance): void {
    app.addHook("onRequest", async (_request, reply) => {
      if (!this.fault) return;
      reply
        .code(this.fault.errorType === "server_error" ? 500 : 503)
        .send({ error: this.fault.message ?? "Fake Hermes unavailable" });
    });

    app.get("/health/detailed", async () => this.getHealth());
    app.get("/v1/capabilities", async () => this.getCapabilities());

    app.post("/api/sessions", async (request, reply) => {
      const body = (request.body ?? {}) as { title?: string };
      const session = this.createSession({ title: body.title });
      return reply.code(201).send({
        object: "hermes.session",
        session: this.toSessionResponse(session),
      });
    });

    app.get("/api/sessions/:sessionId", async (request, reply) => {
      const session = this.sessions.get(
        (request.params as { sessionId: string }).sessionId,
      );
      if (!session) return reply.code(404).send({ error: "not found" });
      return {
        object: "hermes.session",
        session: this.toSessionResponse(session),
      };
    });

    app.patch("/api/sessions/:sessionId", async (request, reply) => {
      const session = this.sessions.get(
        (request.params as { sessionId: string }).sessionId,
      );
      if (!session) return reply.code(404).send({ error: "not found" });
      const body = (request.body ?? {}) as { title?: string; pinned?: boolean };
      if (body.title !== undefined) session.title = body.title;
      if (body.pinned !== undefined) session.pinned = body.pinned;
      session.updatedAt = new Date().toISOString();
      return {
        object: "hermes.session",
        session: this.toSessionResponse(session),
      };
    });

    app.post("/api/sessions/:sessionId/fork", async (request, reply) => {
      const parent = this.sessions.get(
        (request.params as { sessionId: string }).sessionId,
      );
      if (!parent) return reply.code(404).send({ error: "not found" });
      const body = (request.body ?? {}) as { title?: string };
      const child = this.createSession({
        title: body.title ?? `${parent.title} fork`,
        parentSessionId: parent.id,
      });
      return reply.code(201).send({
        object: "hermes.session",
        session: this.toSessionResponse(child),
      });
    });

    app.delete("/api/sessions/:sessionId", async (request, reply) => {
      const sessionId = (request.params as { sessionId: string }).sessionId;
      if (!this.sessions.delete(sessionId))
        return reply.code(404).send({ error: "not found" });
      return { object: "hermes.session.deleted", id: sessionId, deleted: true };
    });

    app.get("/api/sessions/:sessionId/messages", async (request, reply) => {
      const requestedId = (request.params as { sessionId: string }).sessionId;
      const effectiveId =
        this.effectiveSessionOverrides.get(requestedId) ?? requestedId;
      const messages = this.getMessages(effectiveId);
      if (!messages) return reply.code(404).send({ error: "not found" });
      const query = request.query as {
        limit?: string;
        offset?: string;
        order?: "oldest" | "latest";
      };
      const limit = Math.max(1, Number(query.limit ?? 100));
      const offset = Math.max(0, Number(query.offset ?? 0));
      const order = query.order === "latest" ? "latest" : "oldest";
      const ordered = order === "latest" ? [...messages].reverse() : messages;
      const data = ordered.slice(offset, offset + limit);
      return {
        object: "list",
        session_id: effectiveId,
        data,
        pagination: { limit, offset, order, returned: data.length },
      };
    });

    app.post("/v1/runs", async (request, reply) => {
      const body = request.body as { session_id?: string; input?: string };
      if (!body?.session_id || !body.input)
        return reply.code(400).send({ error: "invalid run body" });
      const header = request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(header) ? header[0] : header;
      const result = this.createRun(
        body.session_id,
        body.input,
        idempotencyKey,
      );
      if (result.kind === "error")
        return reply.code(result.status).send({ error: result.message });
      return reply.code(result.replayed ? 200 : 202).send({
        run_id: result.run.id,
        status: result.replayed ? result.run.status : "started",
        replayed: result.replayed,
      });
    });

    app.get("/v1/runs/:runId", async (request, reply) => {
      const run = this.runs.get((request.params as { runId: string }).runId);
      if (!run) return reply.code(404).send({ error: "not found" });
      return {
        run_id: run.id,
        status: run.status,
        partial: run.partial,
        turn_exit_reason: null,
        approval: run.approval,
      };
    });

    app.get("/v1/runs/:runId/events", async (request, reply) => {
      const run = this.runs.get((request.params as { runId: string }).runId);
      if (!run) return reply.code(404).send({ error: "not found" });
      reply.hijack();
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache");
      for (const event of run.events) {
        reply.raw.write(
          `data: ${JSON.stringify({ event: event.type, run_id: run.id, timestamp: Math.floor(Date.now() / 1000), ...event.data })}\n\n`,
        );
      }
      reply.raw.end();
    });

    app.post("/v1/runs/:runId/approval", async (request, reply) => {
      const runId = (request.params as { runId: string }).runId;
      const run = this.runs.get(runId);
      if (!run) return reply.code(404).send({ error: "not found" });
      const body = (request.body ?? {}) as { choice?: unknown };
      if (body.choice !== "once" && body.choice !== "deny")
        return reply.code(400).send({ error: "invalid approval choice" });
      if (run.status !== "waiting_for_approval")
        return reply.code(409).send({ error: "approval is not pending" });
      run.status = "running";
      run.approval = null;
      run.approvalDecision = body.choice;
      run.events = [];
      return reply.code(204).send();
    });

    app.post("/v1/runs/:runId/stop", async (request, reply) => {
      const run = this.runs.get((request.params as { runId: string }).runId);
      if (!run) return reply.code(404).send({ error: "not found" });
      run.status = "stopping";
      run.events = [];
      return reply.code(204).send();
    });
  }

  private createRun(
    sessionId: string,
    input: string,
    idempotencyKey?: string,
  ):
    | { kind: "ok"; run: FakeRun; replayed: boolean }
    | { kind: "error"; status: number; message: string } {
    if (this.fault)
      return {
        kind: "error",
        status: 503,
        message: this.fault.message ?? "Fake Hermes unavailable",
      };
    if (this.failNextRun) {
      this.failNextRun = false;
      return { kind: "error", status: 503, message: "Fake Hermes run failure" };
    }
    const session = this.sessions.get(sessionId);
    if (!session)
      return { kind: "error", status: 404, message: "Session not found" };
    const fingerprint = `${sessionId}\n${input}`;
    if (idempotencyKey) {
      const previous = this.idempotency.get(idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          return {
            kind: "error",
            status: 409,
            message: "Idempotency fingerprint conflict",
          };
        const existing = this.runs.get(previous.runId);
        if (existing) return { kind: "ok", run: existing, replayed: true };
      }
    }

    const waitingForApproval = this.pauseNextRun;
    this.pauseNextRun = false;
    const id = `run_test_${this.nextRun++}`;
    const run: FakeRun = {
      id,
      sessionId,
      input,
      status: waitingForApproval ? "waiting_for_approval" : "completed",
      partial: false,
      approval: waitingForApproval
        ? {
            request_id: `approval_${id}`,
            command: "echo test",
            description: "Fake approval request",
            choices: ["once", "deny"],
          }
        : null,
      approvalDecision: null,
      events: waitingForApproval
        ? [
            {
              type: "approval.request",
              data: { request_id: `approval_${id}`, choices: ["once", "deny"] },
            },
          ]
        : [{ type: "run.completed", data: { run_id: id } }],
    };
    this.runs.set(id, run);
    if (idempotencyKey)
      this.idempotency.set(idempotencyKey, { fingerprint, runId: id });
    session.messages.push(this.createMessage(sessionId, "user", input));
    if (!waitingForApproval)
      this.appendAssistantResult(run, "Fake run completed.");
    return { kind: "ok", run, replayed: false };
  }

  private appendAssistantResult(run: FakeRun, content: string): void {
    const session = this.sessions.get(run.sessionId);
    if (!session) return;
    session.messages.push(
      this.createMessage(run.sessionId, "assistant", content),
    );
    session.updatedAt = new Date().toISOString();
  }

  private requireRun(runId: string): FakeRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run not found");
    return run;
  }

  private createMessage(
    sessionId: string,
    role: HermesMessageItem["role"],
    content: string,
  ): HermesMessageItem {
    return {
      id: this.nextMessage++,
      session_id: sessionId,
      role,
      content,
      timestamp: Math.floor(Date.now() / 1000),
      tool_call_id: null,
      tool_name: null,
      token_count: 1,
      finish_reason: role === "assistant" ? "stop" : null,
      reasoning: null,
      display_kind: null,
    };
  }

  private toSessionResponse(
    session: FakeSession,
    includeListFields = false,
  ): FakeSessionResponse {
    return {
      id: session.id,
      source: "api_server",
      model: null,
      title: session.title,
      started_at: Math.floor(Date.parse(session.createdAt) / 1000),
      ended_at: null,
      message_count: session.messages.length,
      parent_session_id: session.parentSessionId,
      pinned: session.pinned,
      archived: false,
      hidden: false,
      has_system_prompt: false,
      has_model_config: false,
      ...(includeListFields
        ? {
            last_active: Math.floor(Date.parse(session.updatedAt) / 1000),
            preview: session.messages.at(-1)?.content ?? "",
          }
        : {}),
    };
  }
}
