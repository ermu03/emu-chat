import { z } from 'zod';
import { UpstreamRunStatusValues, MessageRoleValues } from './domain-enums.js';

export const HermesHealthSummarySchema = z
  .object({
    status: z.string(),
    version: z.string(),
    commit: z.string().optional()
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
            retention_seconds: z.number()
          })
          .passthrough()
      })
      .passthrough(),
    runtime: z
      .object({
        mode: z.string(),
        tool_execution: z.string()
      })
      .passthrough(),
    endpoints: z.record(z.string(), z.unknown()).or(z.array(z.unknown()))
  })
  .passthrough();
export type HermesCapabilities = z.infer<typeof HermesCapabilitiesSchema>;

export const HermesDetailedHealthSchema = z
  .object({
    status: z.string(),
    active_agents: z.number()
  })
  .passthrough();
export type HermesDetailedHealth = z.infer<typeof HermesDetailedHealthSchema>;

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
    hidden: z.boolean()
  })
  .passthrough();
export type HermesSessionSummary = z.infer<typeof HermesSessionSummarySchema>;

export const HermesSessionListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(HermesSessionSummarySchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    has_more: z.boolean()
  })
  .passthrough();
export type HermesSessionListResponse = z.infer<typeof HermesSessionListResponseSchema>;

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
    display_kind: z.string().nullable().optional()
  })
  .passthrough();
export type HermesMessageItem = z.infer<typeof HermesMessageItemSchema>;

export const HermesMessageListResponseSchema = z
  .object({
    object: z.literal('list'),
    session_id: z.string(),
    data: z.array(HermesMessageItemSchema),
    pagination: z
      .object({
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        order: z.enum(['oldest', 'latest']),
        returned: z.number().int().nonnegative()
      })
      .passthrough()
  })
  .passthrough();
export type HermesMessageListResponse = z.infer<typeof HermesMessageListResponseSchema>;

export const HermesRunAdmissionResponseSchema = z
  .object({
    run_id: z.string(),
    status: z.literal('started'),
    replayed: z.boolean()
  })
  .passthrough();
export type HermesRunAdmissionResponse = z.infer<typeof HermesRunAdmissionResponseSchema>;

export const HermesApprovalSnapshotSchema = z
  .object({
    request_id: z.string(),
    command: z.string().optional(),
    description: z.string().optional(),
    choices: z.array(z.string()),
    deadline_at: z.string().optional()
  })
  .passthrough();
export type HermesApprovalSnapshot = z.infer<typeof HermesApprovalSnapshotSchema>;

export const HermesRunStatusResponseSchema = z
  .object({
    run_id: z.string(),
    status: z.enum(UpstreamRunStatusValues),
    partial: z.boolean().optional(),
    turn_exit_reason: z.string().nullable().optional(),
    pending_steer: z.boolean().optional(),
    approval: HermesApprovalSnapshotSchema.nullable().optional()
  })
  .passthrough();
export type HermesRunStatusResponse = z.infer<typeof HermesRunStatusResponseSchema>;
