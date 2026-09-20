import { z } from "zod";
import { UpstreamRunStatusValues, MessageRoleValues } from "./domain-enums.js";

export const HermesHealthSummarySchema = z
  .object({
    status: z.string(),
    version: z.string(),
    commit: z.string().optional(),
  })
  .passthrough();
export type HermesHealthSummary = z.infer<typeof HermesHealthSummarySchema>;

export const HermesCapabilitiesSchema = z
  .object({
    features: z
      .object({
        run_submission: z.boolean(),
        run_status: z.boolean(),
        run_events_sse: z.boolean(),
        run_stop: z.boolean(),
        run_approval_response: z.boolean(),
        session_resources: z.boolean(),
        session_fork: z.boolean(),
        tool_progress_events: z.boolean(),
        approval_events: z.boolean(),
        runs_idempotency: z
          .object({
            supported: z.boolean(),
            durable: z.boolean(),
            retention_seconds: z.number(),
          })
          .passthrough(),
      })
      .passthrough(),
    runtime: z
      .object({
        mode: z.string(),
        tool_execution: z.string(),
      })
      .passthrough(),
    endpoints: z.array(
      z
        .object({
          method: z.string(),
          path: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type HermesCapabilities = z.infer<typeof HermesCapabilitiesSchema>;

export const HermesDetailedHealthSchema = z
  .object({
    status: z.string(),
    active_agents: z.number(),
  })
  .passthrough();
export type HermesDetailedHealth = z.infer<typeof HermesDetailedHealthSchema>;

/** Detailed capability/health response used as the Hermes readiness gate. */
export const HermesHealthDetailedResponseSchema = z
  .object({
    status: z.string(),
    version: z.string(),
    commit: z.string().optional(),
    runtime: z
      .object({
        mode: z.string(),
        tool_execution: z.string(),
      })
      .passthrough(),
    durable: z.boolean(),
    retention_seconds: z.number().nonnegative(),
    active_agents: z.number().int().nonnegative(),
    features: z
      .object({
        run_submission: z.boolean(),
        run_status: z.boolean(),
        run_events_sse: z.boolean(),
        run_stop: z.boolean(),
        run_approval_response: z.boolean(),
        session_resources: z.boolean(),
        session_fork: z.boolean(),
        tool_progress_events: z.boolean(),
        approval_events: z.boolean(),
        runs_idempotency: z
          .object({
            supported: z.boolean(),
            durable: z.boolean().optional(),
            retention_seconds: z.number().nonnegative().optional(),
            header: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
    endpoints: z.array(
      z
        .object({
          method: z.string(),
          path: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type HermesHealthDetailedResponse = z.infer<
  typeof HermesHealthDetailedResponseSchema
>;

export const HermesSessionSummarySchema = z
  .object({
    id: z.string(),
    source: z.string(),
    title: z.string(),
    message_count: z.number().int().nonnegative(),
    parent_session_id: z.string().nullable(),
    last_active: z.number().nonnegative(),
    preview: z.string(),
    pinned: z.boolean(),
    archived: z.boolean(),
    hidden: z.boolean(),
  })
  .passthrough();
export type HermesSessionSummary = z.infer<typeof HermesSessionSummarySchema>;

/** Full session shape returned by Hermes detail/create/update/fork endpoints. */
export const HermesSessionDetailResponseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    pinned: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
    last_active_at: z.union([z.string(), z.number()]),
    message_count: z.number().int().nonnegative(),
    preview: z.string(),
    model: z.string().optional(),
    system_prompt: z.string().optional(),
    parent_session_id: z.string().nullable(),
    source: z.string().optional(),
    archived: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .passthrough();
export type HermesSessionDetailResponse = z.infer<
  typeof HermesSessionDetailResponseSchema
>;

export const HermesSessionListResponseSchema = z
  .object({
    object: z.literal("list").optional(),
    // Hermes 0.21 uses `data`; retain `sessions` for older compatible test
    // fixtures and normalize it in the adapter.
    data: z.array(HermesSessionDetailResponseSchema).optional(),
    sessions: z.array(HermesSessionDetailResponseSchema).optional(),
    total: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    has_more: z.boolean().optional(),
  })
  .passthrough();
export type HermesSessionListResponse = z.infer<
  typeof HermesSessionListResponseSchema
>;

export const HermesMessageItemSchema = z
  .object({
    id: z.number().int().positive(),
    session_id: z.string(),
    role: z.enum(MessageRoleValues),
    content: z.string(),
    tool_call_id: z.string().nullable().optional(),
    tool_calls: z.array(z.unknown()).optional(),
    tool_name: z.string().nullable().optional(),
    timestamp: z.number().nonnegative(),
    token_count: z.number().int().nonnegative().optional(),
    finish_reason: z.string().nullable().optional(),
    reasoning: z.string().nullable().optional(),
    reasoning_content: z.string().nullable().optional(),
    display_kind: z.string().nullable().optional(),
  })
  .passthrough();
export type HermesMessageItem = z.infer<typeof HermesMessageItemSchema>;
export type HermesMessage = HermesMessageItem;
export const HermesMessageSchema = HermesMessageItemSchema;

export const HermesMessageListResponseSchema = z
  .object({
    object: z.literal("list").optional(),
    session_id: z.string(),
    effective_session_id: z.string().optional(),
    data: z.array(HermesMessageItemSchema).optional(),
    messages: z.array(HermesMessageItemSchema).optional(),
    total: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    order: z.enum(["oldest", "latest"]).optional(),
    has_more: z.boolean().optional(),
    pagination: z
      .object({
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        order: z.enum(["oldest", "latest"]),
        returned: z.number().int().nonnegative(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type HermesMessageListResponse = z.infer<
  typeof HermesMessageListResponseSchema
>;

export const HermesRunAdmissionResponseSchema = z
  .object({
    run_id: z.string(),
    status: z.literal("started"),
    replayed: z.boolean(),
  })
  .passthrough();
export type HermesRunAdmissionResponse = z.infer<
  typeof HermesRunAdmissionResponseSchema
>;

export const HermesApprovalSnapshotSchema = z
  .object({
    request_id: z.string(),
    command: z.string().optional(),
    description: z.string().optional(),
    choices: z.array(z.string()),
    deadline_at: z.string().optional(),
  })
  .passthrough();
export type HermesApprovalSnapshot = z.infer<
  typeof HermesApprovalSnapshotSchema
>;

export const HermesRunStatusResponseSchema = z
  .object({
    run_id: z.string(),
    status: z.enum(UpstreamRunStatusValues),
    partial: z.boolean().optional(),
    turn_exit_reason: z.string().nullable().optional(),
    pending_steer: z.boolean().optional(),
    approval: HermesApprovalSnapshotSchema.nullable().optional(),
  })
  .passthrough();
export type HermesRunStatusResponse = z.infer<
  typeof HermesRunStatusResponseSchema
>;

/** Browser-facing event envelope. Unknown event names remain forward-compatible. */
export interface StreamEventEnvelope {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  local_seq?: number;
}
