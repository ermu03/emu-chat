import Fastify, { type FastifyInstance } from "fastify";
import type {
  HermesHealthDetailedResponse,
  HermesMessageItem,
  HermesSessionDetailResponse,
} from "../../../src/shared/hermes-schemas.js";

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

  getHealth(): HermesHealthDetailedResponse {
    return {
      status: "healthy",
      version: "0.21.3-test",
      runtime: { mode: "server_agent", tool_execution: "server" },
      durable: true,
      retention_seconds: 86_400,
      active_agents: this.activeAgents,
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
      endpoints: [
        { method: "GET", path: "/health/detailed" },
        { method: "GET", path: "/api/sessions" },
        { method: "POST", path: "/api/sessions" },
        { method: "GET", path: "/api/sessions/{session_id}" },
        { method: "PATCH", path: "/api/sessions/{session_id}" },
        { method: "DELETE", path: "/api/sessions/{session_id}" },
        { method: "GET", path: "/api/sessions/{session_id}/messages" },
        { method: "POST", path: "/api/sessions/{session_id}/fork" },
        { method: "POST", path: "/v1/runs" },
        { method: "GET", path: "/v1/runs/{run_id}" },
        { method: "GET", path: "/v1/runs/{run_id}/events" },
        { method: "POST", path: "/v1/runs/{run_id}/approval" },
        { method: "POST", path: "/v1/runs/{run_id}/stop" },
      ],
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

  listSessions(): HermesSessionDetailResponse[] {
    return [...this.sessions.values()].map((session) =>
      this.toSessionDetail(session),
    );
  }

  getSession(id: string): HermesSessionDetailResponse | null {
    const session = this.sessions.get(id);
    return session ? this.toSessionDetail(session) : null;
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

  startRun(
    sessionId: string,
    input: string,
  ): {
    run_id: string;
    session_id: string;
    status: "running" | "paused";
    pause_reason?: string;
    pause_metadata?: { tool: string; command: string };
  } {
    const result = this.createRun(sessionId, input);
    if (result.kind === "error") throw new Error(result.message);
    const paused = result.run.status === "waiting_for_approval";
    return {
      run_id: result.run.id,
      session_id: sessionId,
      status: paused ? "paused" : "running",
      ...(paused
        ? {
            pause_reason: "tool_approval",
            pause_metadata: { tool: "shell_exec", command: "echo test" },
          }
        : {}),
    };
  }

  submitApproval(
    runId: string,
    decision: string,
  ): { run_id: string; status: UpstreamRunStatus } {
    const run = this.requireRun(runId);
    if (decision === "approve" || decision === "once") {
      run.status = "completed";
      run.approval = null;
      run.events = [{ type: "run.completed", data: { run_id: run.id } }];
      this.appendAssistantResult(run, "Tool approval completed.");
    } else {
      run.status = "cancelled";
      run.approval = null;
      run.events = [{ type: "run.cancelled", data: { run_id: run.id } }];
    }
    return { run_id: run.id, status: run.status };
  }

  handleGetSessions(): {
    sessions: HermesSessionDetailResponse[];
    total: number;
  } {
    const sessions = this.listSessions();
    return { sessions, total: sessions.length };
  }

  handleStartRun(
    sessionId: string,
    body: { prompt: string; idempotency_key?: string },
  ): { status: number; run?: { id: string }; error?: string } {
    const result = this.createRun(sessionId, body.prompt, body.idempotency_key);
    if (result.kind === "error")
      return { status: result.status, error: result.message };
    return { status: result.replayed ? 200 : 202, run: { id: result.run.id } };
  }

  handleSubmitApproval(
    _sessionId: string,
    runId: string,
    body: { decision?: string; choice?: string },
  ): { status: number } {
    this.submitApproval(runId, body.choice ?? body.decision ?? "deny");
    return { status: 200 };
  }

  handleCancelRun(_sessionId: string, runId: string): { status: number } {
    const run = this.requireRun(runId);
    run.status = "cancelled";
    run.events = [{ type: "run.cancelled", data: { run_id: run.id } }];
    return { status: 200 };
  }

  handleDeleteSession(sessionId: string): { status: number } {
    if (!this.sessions.delete(sessionId)) return { status: 404 };
    return { status: 200 };
  }

  private registerRoutes(app: FastifyInstance): void {
    app.addHook("onRequest", async (_request, reply) => {
      if (!this.fault) return;
      reply
        .code(this.fault.errorType === "server_error" ? 500 : 503)
        .send({ error: this.fault.message ?? "Fake Hermes unavailable" });
    });

    app.get("/health/detailed", async () => this.getHealth());

    app.get("/api/sessions", async (request) => {
      const query = request.query as { limit?: string; offset?: string };
      const limit = Math.max(1, Number(query.limit ?? 50));
      const offset = Math.max(0, Number(query.offset ?? 0));
      const sessions = this.listSessions();
      return {
        object: "list",
        data: sessions.slice(offset, offset + limit),
        total: sessions.length,
        limit,
        offset,
        has_more: offset + limit < sessions.length,
      };
    });

    app.post("/api/sessions", async (request, reply) => {
      const body = (request.body ?? {}) as { title?: string };
      const session = this.createSession({ title: body.title });
      return reply.code(201).send(this.toSessionDetail(session));
    });

    app.get("/api/sessions/:sessionId", async (request, reply) => {
      const session = this.getSession(
        (request.params as { sessionId: string }).sessionId,
      );
      if (!session) return reply.code(404).send({ error: "not found" });
      return session;
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
      return this.toSessionDetail(session);
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
      return reply.code(201).send(this.toSessionDetail(child));
    });

    app.delete("/api/sessions/:sessionId", async (request, reply) => {
      const result = this.handleDeleteSession(
        (request.params as { sessionId: string }).sessionId,
      );
      return reply.code(result.status).send();
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
        status: "started",
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
        pending_steer: false,
        approval: run.approval,
      };
    });

    app.get("/v1/runs/:runId/events", async (request, reply) => {
      const run = this.runs.get((request.params as { runId: string }).runId);
      if (!run) return reply.code(404).send({ error: "not found" });
      reply.hijack();
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache");
      for (const [index, event] of run.events.entries()) {
        reply.raw.write(
          `id: ${index + 1}\nevent: ${event.type}\ndata: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`,
        );
      }
      reply.raw.end();
    });

    app.post("/v1/runs/:runId/approval", async (request, reply) => {
      const runId = (request.params as { runId: string }).runId;
      if (!this.runs.has(runId))
        return reply.code(404).send({ error: "not found" });
      const body = (request.body ?? {}) as { choice?: string };
      this.submitApproval(runId, body.choice ?? "deny");
      return reply.code(204).send();
    });

    app.post("/v1/runs/:runId/stop", async (request, reply) => {
      const run = this.runs.get((request.params as { runId: string }).runId);
      if (!run) return reply.code(404).send({ error: "not found" });
      run.status = "cancelled";
      run.events = [{ type: "run.cancelled", data: { run_id: run.id } }];
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
      timestamp: Date.now(),
      tool_call_id: null,
      tool_name: null,
      token_count: 1,
      finish_reason: role === "assistant" ? "stop" : null,
      reasoning: null,
      display_kind: null,
    };
  }

  private toSessionDetail(session: FakeSession): HermesSessionDetailResponse {
    return {
      id: session.id,
      title: session.title,
      pinned: session.pinned,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      last_active_at: session.updatedAt,
      message_count: session.messages.length,
      preview: session.messages.at(-1)?.content ?? "",
      parent_session_id: session.parentSessionId,
      source: "api_server",
      archived: false,
      hidden: false,
    };
  }
}
