/**
 * Anonymized wire samples from Hermes 0.21.x. They deliberately contain no
 * local session IDs, prompts, messages, or credentials.
 */
export const realHermesDetailedHealth = {
  status: "ok",
  readiness: { status: "ok", checks: {} },
  platform: "hermes-agent",
  version: "0.21.3",
  gateway_state: "running",
  platforms: {},
  active_agents: 0,
  gateway_busy: false,
  gateway_drainable: true,
  exit_reason: null,
  updated_at: "2026-09-20T00:00:00.000Z",
  pid: 100,
};

/** A reachable Hermes process that must not admit new work. */
export const realHermesNonOkDetailedHealth = {
  ...realHermesDetailedHealth,
  status: "degraded",
};

export const realHermesCapabilities = {
  object: "hermes.api_server.capabilities",
  platform: "hermes-agent",
  runtime: {
    mode: "server_agent",
    tool_execution: "server",
    split_runtime: false,
  },
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

export const realHermesSessionDetail = {
  object: "hermes.session",
  session: {
    id: "api_anonymous_session",
    source: "api_server",
    model: null,
    title: "",
    started_at: 1_726_787_200,
    ended_at: null,
    message_count: 1,
    parent_session_id: null,
    pinned: false,
    archived: false,
    hidden: false,
    has_system_prompt: false,
    has_model_config: false,
  },
};

/** A structurally valid detail response for a different requested resource. */
export const realHermesMismatchedSessionDetail = {
  ...realHermesSessionDetail,
  session: {
    ...realHermesSessionDetail.session,
    id: "api_different_session",
  },
};

export const realHermesMessageList = {
  object: "list",
  session_id: "api_anonymous_session",
  data: [
    {
      id: 1,
      session_id: "api_anonymous_session",
      role: "assistant",
      content: "",
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      timestamp: 1_726_790_800,
      token_count: null,
      finish_reason: null,
      reasoning: null,
      reasoning_content: null,
      display_kind: null,
    },
  ],
  pagination: {},
};

export const realHermesReplayAdmission = {
  run_id: "run_anonymous",
  status: "completed",
  replayed: true,
};

export const realHermesFlatSseEvent = {
  event: "message.delta",
  run_id: "run_anonymous",
  timestamp: 1_726_790_800,
  delta: "partial response",
};
