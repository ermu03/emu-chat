import { z } from 'zod';
import {
  ConnectionStatusHermesValues,
  PauseReasonValues,
  QueueItemStateValues,
  RunLocalStateValues,
  UpstreamRunStatusValues,
  DeleteStateValues,
  ApprovalChoiceValues,
  ThemePreferenceValues,
  SendShortcutPreferenceValues,
  ErrorCodeValues,
  StreamGapReasonValues,
  MessageRoleValues
} from './domain-enums.js';
import { LIMITS } from './limits.js';

// --- Error Envelope ---
export const ErrorActionValues = [
  'none',
  'retry',
  'recheck',
  'refresh_status',
  'resolve_conflict',
  'review_required',
  'reconnect'
] as const;
export type ErrorAction = (typeof ErrorActionValues)[number];

export const ApiErrorPayloadSchema = z.object({
  code: z.enum(ErrorCodeValues),
  message: z.string(),
  retryable: z.boolean(),
  action: z.enum(ErrorActionValues),
  request_id: z.string(),
  upstream_status: z.number().int().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});
export type ApiErrorPayload = z.infer<typeof ApiErrorPayloadSchema>;

export const ApiErrorEnvelopeSchema = z.object({
  error: ApiErrorPayloadSchema
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

// --- System Status ---
export const ConnectionStatusResponseSchema = z.object({
  status: z.enum(ConnectionStatusHermesValues),
  hermes_version: z.string().nullable(),
  missing_capabilities: z.array(z.string()),
  last_checked_at: z.string(),
  suggested_action: z.string(),
  lan_http_warning: z.boolean(),
  pwa_secure_context_required: z.boolean()
});
export type ConnectionStatusResponse = z.infer<typeof ConnectionStatusResponseSchema>;

// --- Conversation Schemas ---
export const ConversationSummarySchema = z.object({
  conversation_id: z.string(),
  hermes_session_id: z.string(),
  effective_hermes_session_id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  tags: z.array(z.string()),
  custom_order: z.number().nullable(),
  last_active: z.number().nonnegative(),
  message_count: z.number().int().nonnegative(),
  preview: z.string(),
  has_active_run: z.boolean(),
  queue_size: z.number().int().nonnegative(),
  queue_paused: z.boolean(),
  has_recovery: z.boolean(),
  delete_state: z.enum(DeleteStateValues),
  local_revision: z.number().int().positive()
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListResponseSchema = z.object({
  items: z.array(ConversationSummarySchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean()
});
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;

export const ConversationDetailResponseSchema = ConversationSummarySchema.extend({
  parent_session_id: z.string().nullable(),
  pause_reason: z.enum(PauseReasonValues).nullable(),
  current_local_run_id: z.string().nullable(),
  delete_failed_reason: z.string().nullable()
});
export type ConversationDetailResponse = z.infer<typeof ConversationDetailResponseSchema>;

export const CreateConversationRequestSchema = z.object({
  title: z.string().max(LIMITS.TITLE_MAX_CHARS).optional()
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const ResetConversationRequestSchema = z.object({
  title: z.string().max(LIMITS.TITLE_MAX_CHARS).optional()
});
export type ResetConversationRequest = z.infer<typeof ResetConversationRequestSchema>;

export const ForkConversationRequestSchema = z.object({
  title: z.string().max(LIMITS.TITLE_MAX_CHARS).optional()
});
export type ForkConversationRequest = z.infer<typeof ForkConversationRequestSchema>;

export const PatchHermesMetadataRequestSchema = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('title'),
    value: z.string().max(LIMITS.TITLE_MAX_CHARS)
  }),
  z.object({
    field: z.literal('pinned'),
    value: z.boolean()
  })
]);
export type PatchHermesMetadataRequest = z.infer<typeof PatchHermesMetadataRequestSchema>;

export const PatchLocalMetadataRequestSchema = z.object({
  expected_revision: z.number().int().positive(),
  tags: z
    .array(z.string().max(LIMITS.TAG_MAX_CHARS))
    .max(LIMITS.TAGS_MAX_COUNT)
    .optional(),
  custom_order: z.number().nullable().optional()
});
export type PatchLocalMetadataRequest = z.infer<typeof PatchLocalMetadataRequestSchema>;

export const DeleteConversationRequestSchema = z.object({
  expected_hermes_session_id: z.string(),
  confirmed: z.boolean()
});
export type DeleteConversationRequest = z.infer<typeof DeleteConversationRequestSchema>;

export const DeleteConversationResponseSchema = z.object({
  conversation_id: z.string(),
  hermes_deleted: z.boolean(),
  local_cleaned: z.boolean()
});
export type DeleteConversationResponse = z.infer<typeof DeleteConversationResponseSchema>;

// --- Messages ---
export const MessageItemSchema = z.object({
  id: z.number().int().positive(),
  session_id: z.string(),
  role: z.enum(MessageRoleValues),
  content: z.string(),
  tool_call_id: z.string().nullable(),
  tool_name: z.string().nullable(),
  timestamp: z.number().nonnegative(),
  token_count: z.number().int().nonnegative().nullable(),
  finish_reason: z.string().nullable(),
  reasoning: z.string().nullable(),
  display_kind: z.string().nullable()
});
export type MessageItem = z.infer<typeof MessageItemSchema>;

export const MessageListResponseSchema = z.object({
  items: z.array(MessageItemSchema),
  effective_hermes_session_id: z.string(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  order: z.enum(['oldest', 'latest']),
  returned: z.number().int().nonnegative()
});
export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;

// --- Draft ---
export const DraftResponseSchema = z.object({
  conversation_id: z.string(),
  content: z.string(),
  revision: z.number().int().positive(),
  updated_at: z.string()
});
export type DraftResponse = z.infer<typeof DraftResponseSchema>;

export const PutDraftRequestSchema = z.object({
  content: z.string().max(LIMITS.INPUT_MAX_BYTES),
  expected_revision: z.number().int().positive()
});
export type PutDraftRequest = z.infer<typeof PutDraftRequestSchema>;

// --- Queue ---
export const SendMessageRequestSchema = z.object({
  client_request_id: z.string(),
  expected_draft_revision: z.number().int().positive()
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = z.object({
  queue_item_id: z.string(),
  state: z.enum(QueueItemStateValues),
  position: z.number().int().nonnegative()
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const QueueItemResponseSchema = z.object({
  queue_item_id: z.string(),
  conversation_id: z.string(),
  state: z.enum(QueueItemStateValues),
  position: z.number().int().nonnegative(),
  has_payload: z.boolean(),
  payload_preview: z.string(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  current_local_run_id: z.string().nullable(),
  pause_reason: z.enum(PauseReasonValues).nullable(),
  review_reason: z.string().nullable(),
  recovery_available: z.boolean(),
  recovery_expires_at: z.string().nullable()
});
export type QueueItemResponse = z.infer<typeof QueueItemResponseSchema>;

export const QueueListResponseSchema = z.object({
  items: z.array(QueueItemResponseSchema),
  queue_paused: z.boolean(),
  pause_reason: z.enum(PauseReasonValues).nullable()
});
export type QueueListResponse = z.infer<typeof QueueListResponseSchema>;

export const PatchQueueItemRequestSchema = z.object({
  content: z.string().max(LIMITS.INPUT_MAX_BYTES),
  expected_revision: z.number().int().positive()
});
export type PatchQueueItemRequest = z.infer<typeof PatchQueueItemRequestSchema>;

export const CancelQueueItemRequestSchema = z.object({
  expected_revision: z.number().int().positive()
});
export type CancelQueueItemRequest = z.infer<typeof CancelQueueItemRequestSchema>;

export const ResumeQueueResponseSchema = z.object({
  queue_paused: z.boolean(),
  resumed_count: z.number().int().nonnegative()
});
export type ResumeQueueResponse = z.infer<typeof ResumeQueueResponseSchema>;

export const CopyToDraftRequestSchema = z.object({
  expected_draft_revision: z.number().int().positive(),
  overwrite_nonempty: z.boolean().optional()
});
export type CopyToDraftRequest = z.infer<typeof CopyToDraftRequestSchema>;

export const CopyToDraftResponseSchema = z.object({
  draft_revision: z.number().int().positive()
});
export type CopyToDraftResponse = z.infer<typeof CopyToDraftResponseSchema>;

// --- Runs ---
export const RunWaitingApprovalSchema = z.object({
  request_id: z.string(),
  command: z.string().optional(),
  description: z.string().optional(),
  choices: z.array(z.string()),
  deadline_at: z.string().optional()
});
export type RunWaitingApproval = z.infer<typeof RunWaitingApprovalSchema>;

export const RunResponseSchema = z.object({
  local_run_id: z.string(),
  conversation_id: z.string(),
  queue_item_id: z.string(),
  hermes_run_id: z.string().nullable(),
  state: z.enum(RunLocalStateValues),
  upstream_status: z.enum(UpstreamRunStatusValues).nullable(),
  turn_exit_reason: z.string().nullable(),
  pending_steer: z.boolean(),
  admission_attempts: z.number().int().nonnegative(),
  first_attempt_at: z.string(),
  last_attempt_at: z.string().nullable(),
  waiting_approval: RunWaitingApprovalSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string()
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

export const ApprovalRequestSchema = z.object({
  choice: z.enum(ApprovalChoiceValues),
  request_id: z.string().optional()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ReconcileResponseSchema = z.object({
  state: z.enum(RunLocalStateValues),
  reconciled: z.boolean()
});
export type ReconcileResponse = z.infer<typeof ReconcileResponseSchema>;

// --- Preferences ---
export const PreferencesResponseSchema = z.object({
  theme: z.enum(ThemePreferenceValues),
  sidebar_width: z.number().int(),
  send_shortcut: z.enum(SendShortcutPreferenceValues),
  revision: z.number().int().positive(),
  updated_at: z.string()
});
export type PreferencesResponse = z.infer<typeof PreferencesResponseSchema>;

export const PutPreferencesRequestSchema = z.object({
  theme: z.enum(ThemePreferenceValues),
  sidebar_width: z
    .number()
    .int()
    .min(LIMITS.SIDEBAR_WIDTH_MIN)
    .max(LIMITS.SIDEBAR_WIDTH_MAX),
  send_shortcut: z.enum(SendShortcutPreferenceValues),
  expected_revision: z.number().int().positive()
});
export type PutPreferencesRequest = z.infer<typeof PutPreferencesRequestSchema>;

// --- SSE Event Schemas ---
export const SseRunDeltaPayloadSchema = z.object({
  local_run_id: z.string(),
  text: z.string()
});
export const SseRunToolStartedPayloadSchema = z.object({
  local_run_id: z.string(),
  tool_name: z.string(),
  tool_call_id: z.string().optional()
});
export const SseRunToolCompletedPayloadSchema = z.object({
  local_run_id: z.string(),
  tool_name: z.string(),
  tool_call_id: z.string().optional(),
  preview: z.string().optional()
});
export const SseRunReasoningDeltaPayloadSchema = z.object({
  local_run_id: z.string(),
  text: z.string()
});
export const SseRunSubagentStartedPayloadSchema = z.object({
  local_run_id: z.string(),
  id: z.string(),
  name: z.string().optional()
});
export const SseRunSubagentCompletedPayloadSchema = z.object({
  local_run_id: z.string(),
  id: z.string()
});
export const SseRunApprovalRequiredPayloadSchema = z.object({
  local_run_id: z.string(),
  request_id: z.string(),
  command: z.string().optional(),
  description: z.string().optional(),
  choices: z.array(z.string()),
  deadline_at: z.string().optional()
});
export const SseRunReconciledPayloadSchema = z.object({
  local_run_id: z.string(),
  upstream_status: z.enum(UpstreamRunStatusValues),
  effective_hermes_session_id: z.string()
});
export const SseRunPausedPayloadSchema = z.object({
  local_run_id: z.string(),
  reason: z.enum(PauseReasonValues),
  review_required: z.boolean()
});
export const SseStreamGapPayloadSchema = z.object({
  local_run_id: z.string(),
  reason: z.enum(StreamGapReasonValues),
  suggested_action: z.literal('refresh_status')
});
export const SseHeartbeatPayloadSchema = z.object({
  local_run_id: z.string(),
  timestamp: z.number().nonnegative()
});
