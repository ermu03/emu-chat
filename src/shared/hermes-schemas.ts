import { z } from "zod";
import { UpstreamRunStatusValues, MessageRoleValues } from "./domain-enums.js";

const HermesRuntimeSchema = z
  .object({
    mode: z.string(),
    tool_execution: z.string(),
  })
  .passthrough();

const HermesRunIdempotencySchema = z
  .object({
    supported: z.boolean(),
    durable: z.boolean().optional(),
    retention_seconds: z.number().nonnegative().optional(),
    header: z.string().optional(),
  })
  .passthrough();

const HermesFeaturesSchema = z
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
    runs_idempotency: HermesRunIdempotencySchema,
  })
  .passthrough();

const HermesEndpointSchema = z
  .object({
    method: z.string(),
    path: z.string(),
  })
  .passthrough();

/** Machine-readable capability response from GET /v1/capabilities. */
export const HermesCapabilitiesSchema = z
  .object({
    features: HermesFeaturesSchema,
    runtime: HermesRuntimeSchema,
    endpoints: z.record(z.string(), HermesEndpointSchema),
  })
  .passthrough();

/** Wire shape from GET /health/detailed before capability normalization. */
export const HermesDetailedHealthSchema = z
  .object({
    status: z.string(),
    version: z.string(),
    commit: z.string().optional(),
    active_agents: z.number().int().nonnegative(),
  })
  .passthrough();

/** Internal readiness view assembled from Hermes health and capabilities APIs. */
export const HermesHealthDetailedResponseSchema = z
  .object({
    status: z.string(),
    version: z.string(),
    commit: z.string().optional(),
    runtime: HermesRuntimeSchema,
    durable: z.boolean(),
    retention_seconds: z.number().nonnegative(),
    active_agents: z.number().int().nonnegative(),
    features: HermesFeaturesSchema,
    endpoints: z.array(HermesEndpointSchema),
  })
  .passthrough();
export type HermesHealthDetailedResponse = z.infer<
  typeof HermesHealthDetailedResponseSchema
>;

/** Internal session shape used after native Hermes responses are normalized. */
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

/** Raw session item returned by Hermes 0.21 resource endpoints. */
export const HermesSessionWireSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    title: z.string(),
    pinned: z.boolean(),
    started_at: z.number().nonnegative(),
    last_active: z.number().nonnegative().optional(),
    message_count: z.number().int().nonnegative(),
    preview: z.string().optional(),
    model: z.string().nullable().optional(),
    parent_session_id: z.string().nullable(),
    archived: z.boolean(),
    hidden: z.boolean(),
  })
  .passthrough();
export type HermesSessionWire = z.infer<typeof HermesSessionWireSchema>;

export const HermesSessionEnvelopeSchema = z
  .object({
    object: z.literal("hermes.session"),
    session: HermesSessionWireSchema,
  })
  .passthrough();

export const HermesMessageItemSchema = z
  .object({
    id: z.number().int().positive(),
    session_id: z.string(),
    role: z.enum(MessageRoleValues),
    content: z.string(),
    tool_call_id: z.string().nullable().optional(),
    tool_calls: z.array(z.unknown()).nullable().optional(),
    tool_name: z.string().nullable().optional(),
    timestamp: z.number().nonnegative(),
    token_count: z.number().int().nonnegative().nullable().optional(),
    finish_reason: z.string().nullable().optional(),
    reasoning: z.string().nullable().optional(),
    reasoning_content: z.string().nullable().optional(),
    display_kind: z.string().nullable().optional(),
  })
  .passthrough();
export type HermesMessageItem = z.infer<typeof HermesMessageItemSchema>;

export const HermesMessageListResponseSchema = z
  .object({
    object: z.literal("list"),
    session_id: z.string(),
    data: z.array(HermesMessageItemSchema),
    pagination: z
      .object({
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        order: z.enum(["oldest", "latest"]).optional(),
        returned: z.number().int().nonnegative().optional(),
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
    status: z.union([z.literal("started"), z.enum(UpstreamRunStatusValues)]),
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

export const HermesRunStatusResponseSchema = z
  .object({
    run_id: z.string(),
    status: z.enum(UpstreamRunStatusValues),
    partial: z.boolean().optional(),
    turn_exit_reason: z.string().nullable().optional(),
    pending_steer: z.string().optional(),
    approval: HermesApprovalSnapshotSchema.nullable().optional(),
  })
  .passthrough();
export type HermesRunStatusResponse = z.infer<
  typeof HermesRunStatusResponseSchema
>;
