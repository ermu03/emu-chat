import type { HermesHealthDetailedResponse } from "../../shared/hermes-schemas.js";

export interface CapabilitiesCheckResult {
  healthy: boolean;
  status: "healthy" | "degraded" | "incompatible" | "unreachable";
  missingCapabilities: string[];
  lanHttpWarning?: boolean;
}

export function evaluateHermesCapabilities(
  health: HermesHealthDetailedResponse,
): CapabilitiesCheckResult {
  const missing: string[] = [];

  const f = health.features;
  if (!f.run_submission) missing.push("features.run_submission");
  if (!f.run_status) missing.push("features.run_status");
  if (!f.run_events_sse) missing.push("features.run_events_sse");
  if (!f.run_stop) missing.push("features.run_stop");
  if (!f.run_approval_response) missing.push("features.run_approval_response");
  if (!f.session_resources) missing.push("features.session_resources");
  if (!f.session_fork) missing.push("features.session_fork");
  if (!f.tool_progress_events) missing.push("features.tool_progress_events");
  if (!f.approval_events) missing.push("features.approval_events");

  if (!f.runs_idempotency?.supported) {
    missing.push("features.runs_idempotency.supported");
  }

  if (health.durable !== true) {
    missing.push("durable=true");
  }

  if (
    typeof health.retention_seconds !== "number" ||
    health.retention_seconds < 86400
  ) {
    missing.push("retention_seconds>=86400");
  }

  const ep = health.endpoints;
  const requiredEndpoints: Array<{ method: string; path: string }> = [
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
  ];

  for (const req of requiredEndpoints) {
    const found = ep.some(
      (e) => e.method.toUpperCase() === req.method && e.path === req.path,
    );
    if (!found) {
      missing.push(`endpoint:${req.method} ${req.path}`);
    }
  }

  if (health.runtime?.mode !== "server_agent") {
    missing.push("runtime.mode=server_agent");
  }
  if (health.runtime?.tool_execution !== "server") {
    missing.push("runtime.tool_execution=server");
  }

  if (missing.length > 0) {
    return {
      healthy: false,
      status: "incompatible",
      missingCapabilities: missing,
    };
  }

  return {
    healthy: true,
    status: "healthy",
    missingCapabilities: [],
  };
}
