import type { HermesHealthDetailedResponse } from "../../../src/shared/hermes-schemas.js";

export const validCapabilitiesHealthResponse: HermesHealthDetailedResponse = {
  status: "healthy",
  version: "0.9.5",
  runtime: {
    mode: "server_agent",
    tool_execution: "server",
  },
  durable: true,
  retention_seconds: 86400,
  active_agents: 0,
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
      retention_seconds: 86400,
      header: "Idempotency-Key",
    },
  },
  endpoints: [
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
    { method: "GET", path: "/health/detailed" },
  ],
};

export const incompatibleMissingEndpointsHealthResponse: HermesHealthDetailedResponse =
  {
    ...validCapabilitiesHealthResponse,
    endpoints: [{ method: "GET", path: "/api/sessions" }],
  };

export const incompatibleDisabledFeatureHealthResponse: HermesHealthDetailedResponse =
  {
    ...validCapabilitiesHealthResponse,
    features: {
      ...validCapabilitiesHealthResponse.features,
      session_fork: false,
    },
  };

export const incompatibleShortRetentionHealthResponse: HermesHealthDetailedResponse =
  {
    ...validCapabilitiesHealthResponse,
    retention_seconds: 3600, // less than 86400
  };
