import { z } from "zod";
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
  MessageRoleValues,
} from "./domain-enums.js";
import { LIMITS } from "./limits.js";

// --- Error Envelope ---
export const ErrorActionValues = [
  "none",
  "retry",
  "recheck",
  "refresh_status",
  "resolve_conflict",
  "review_required",
  "reconnect",
] as const;
export type ErrorAction = (typeof ErrorActionValues)[number];

export const ApiErrorPayloadSchema = z.object({
  code: z.enum(ErrorCodeValues),
  message: z.string(),
  retryable: z.boolean(),
  action: z.enum(ErrorActionValues),
  request_id: z.string(),
  upstream_status: z.number().int().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiErrorPayload = z.infer<typeof ApiErrorPayloadSchema>;

export const ApiErrorEnvelopeSchema = z.object({
  error: ApiErrorPayloadSchema,
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
  pwa_secure_context_required: z.boolean(),
});
export type ConnectionStatusResponse = z.infer<
  typeof ConnectionStatusResponseSchema
>;

export const GetConversationsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.SESSION_LIST_PAGE_MAX)
      .default(LIMITS.SESSION_LIST_PAGE_DEFAULT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type GetConversationsQuery = z.infer<typeof GetConversationsQuerySchema>;

export const GetMessagesQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.MESSAGES_PAGE_MAX)
      .default(LIMITS.MESSAGES_PAGE_DEFAULT),
    offset: z.coerce.number().int().min(0).default(0),
    order: z.enum(["oldest", "latest"]).default("oldest"),
  })
  .strict();
export type GetMessagesQuery = z.infer<typeof GetMessagesQuerySchema>;

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
  local_revision: z.number().int().nonnegative(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListResponseSchema = z.object({
  items: z.array(ConversationSummarySchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
});
export type ConversationListResponse = z.infer<
  typeof ConversationListResponseSchema
>;

export const ConversationDetailResponseSchema =
  ConversationSummarySchema.extend({
    parent_session_id: z.string().nullable(),
    pause_reason: z.enum(PauseReasonValues).nullable(),
    current_local_run_id: z.string().nullable(),
    delete_failed_reason: z.string().nullable(),
  });
export type ConversationDetailResponse = z.infer<
  typeof ConversationDetailResponseSchema
>;

export const CreateConversationRequestSchema = z.object({
  title: z.string().max(LIMITS.TITLE_MAX_CHARS).optional(),
});
export type CreateConversationRequest = z.infer<
  typeof CreateConversationRequestSchema
>;

export const ResetConversationRequestSchema = z.object({
  title: z.string().max(LIMITS.TITLE_MAX_CHARS).optional(),
});
export type ResetConversationRequest = z.infer<
  typeof ResetConversationRequestSchema
>;

export const ForkConversationRequestSchema = z.object({
  title: z.string().max(LIMITS.TITLE_MAX_CHARS).optional(),
});
export type ForkConversationRequest = z.infer<
  typeof ForkConversationRequestSchema
>;

export const PatchHermesMetadataRequestSchema = z.discriminatedUnion("field", [
  z.object({
    field: z.literal("title"),
    value: z.string().max(LIMITS.TITLE_MAX_CHARS),
  }),
  z.object({
    field: z.literal("pinned"),
    value: z.boolean(),
  }),
]);
export type PatchHermesMetadataRequest = z.infer<
  typeof PatchHermesMetadataRequestSchema
>;

export const PatchLocalMetadataRequestSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  tags: z
    .array(z.string().max(LIMITS.TAG_MAX_CHARS))
    .max(LIMITS.TAGS_MAX_COUNT)
    .optional(),
  custom_order: z.number().nullable().optional(),
});
export type PatchLocalMetadataRequest = z.infer<
  typeof PatchLocalMetadataRequestSchema
>;

export const DeleteConversationRequestSchema = z.object({
  expected_hermes_session_id: z.string().min(1),
  confirmed: z.boolean(),
});
export type DeleteConversationRequest = z.infer<
  typeof DeleteConversationRequestSchema
>;

export const DeleteConversationResponseSchema = z.object({
  conversation_id: z.string(),
  hermes_deleted: z.boolean(),
  local_cleaned: z.boolean(),
});
export type DeleteConversationResponse = z.infer<
  typeof DeleteConversationResponseSchema
>;

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
  display_kind: z.string().nullable(),
});
export type MessageItem = z.infer<typeof MessageItemSchema>;

export const MessageListResponseSchema = z.object({
  items: z.array(MessageItemSchema),
  effective_hermes_session_id: z.string(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  order: z.enum(["oldest", "latest"]),
  returned: z.number().int().nonnegative(),
  has_more: z.boolean(),
  total: z.number().int().nonnegative().optional(),
});
export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;

// --- Draft ---
export const DraftResponseSchema = z.object({
  object: z.literal("emu_chat.draft"),
  conversation_id: z.string(),
  content: z.string(),
  revision: z.number().int().nonnegative(),
  updated_at: z.string().nullable(),
});
export type DraftResponse = z.infer<typeof DraftResponseSchema>;

export const PutDraftRequestSchema = z
  .object({
    // Byte length is checked by the service. Zod's string max counts code units.
    content: z.string(),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
export type PutDraftRequest = z.infer<typeof PutDraftRequestSchema>;

// --- Queue ---
export const QueueItemResponseSchema = z.object({
  object: z.literal("emu_chat.queue_item"),
  id: z.string(),
  conversation_id: z.string(),
  operation_id: z.string(),
  fifo_seq: z.number().int().positive(),
  state: z.enum(QueueItemStateValues),
  content: z.string().nullable(),
  payload_bytes: z.number().int().positive(),
  payload_available: z.boolean(),
  recovery_expires_at: z.string().nullable(),
  payload_expired_at: z.string().nullable(),
  local_run_id: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  last_error_code: z.string().nullable(),
});
export type QueueItemResponse = z.infer<typeof QueueItemResponseSchema>;

export const QueueListResponseSchema = z.object({
  object: z.literal("emu_chat.queue"),
  conversation_id: z.string(),
  paused: z.boolean(),
  pause_reason: z.enum(PauseReasonValues).nullable(),
  data: z.array(QueueItemResponseSchema),
});
export type QueueListResponse = z.infer<typeof QueueListResponseSchema>;

export const SendMessageRequestSchema = z
  .object({
    client_request_id: z.uuid(),
    expected_draft_revision: z.number().int().nonnegative(),
  })
  .strict();
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = z.object({
  object: z.literal("emu_chat.message_submission"),
  replayed: z.boolean(),
  queue_item: QueueItemResponseSchema,
  draft: DraftResponseSchema,
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const GetQueueQuerySchema = z
  .object({
    include_terminal: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .strict();
export type GetQueueQuery = z.infer<typeof GetQueueQuerySchema>;

export const PatchQueueItemRequestSchema = z
  .object({
    content: z.string(),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
export type PatchQueueItemRequest = z.infer<typeof PatchQueueItemRequestSchema>;

export const CancelQueueItemRequestSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
export type CancelQueueItemRequest = z.infer<
  typeof CancelQueueItemRequestSchema
>;

export const ResumeQueueRequestSchema = z.object({}).strict();
export type ResumeQueueRequest = z.infer<typeof ResumeQueueRequestSchema>;

export const ResumeQueueResponseSchema = QueueListResponseSchema;
export type ResumeQueueResponse = z.infer<typeof ResumeQueueResponseSchema>;

export const CopyToDraftRequestSchema = z
  .object({
    expected_draft_revision: z.number().int().nonnegative(),
    overwrite_nonempty: z.boolean().optional().default(false),
  })
  .strict();
export type CopyToDraftRequest = z.infer<typeof CopyToDraftRequestSchema>;

export const CopyToDraftResponseSchema = z.object({
  object: z.literal("emu_chat.recovery_copy"),
  draft: DraftResponseSchema,
  duplicate_risk: z.literal(true),
});
export type CopyToDraftResponse = z.infer<typeof CopyToDraftResponseSchema>;

export const DiscardRecoveryRequestSchema = z.object({}).strict();
export type DiscardRecoveryRequest = z.infer<
  typeof DiscardRecoveryRequestSchema
>;

// --- Runs ---
export const RunApprovalSchema = z.object({
  request_id: z.string(),
  command: z.string().optional(),
  description: z.string().optional(),
  choices: z.array(z.enum(ApprovalChoiceValues)),
  deadline_at: z.string().optional(),
});
export type RunApproval = z.infer<typeof RunApprovalSchema>;

export const RunResponseSchema = z.object({
  object: z.literal("emu_chat.run"),
  id: z.string(),
  conversation_id: z.string(),
  queue_item_id: z.string(),
  hermes_run_id: z.string().nullable(),
  local_state: z.enum(RunLocalStateValues),
  upstream_status: z.enum(UpstreamRunStatusValues).nullable(),
  partial: z.boolean(),
  last_event_seq: z.number().int().nonnegative(),
  events_truncated: z.boolean(),
  approval: RunApprovalSchema.nullable(),
  last_error_code: z.string().nullable(),
  started_at: z.string(),
  terminal_at: z.string().nullable(),
  updated_at: z.string(),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

export const ApprovalRequestSchema = z
  .object({
    choice: z.enum(ApprovalChoiceValues),
    request_id: z.string().optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ReconcileResponseSchema = z.object({
  object: z.literal("emu_chat.reconciliation"),
  run: RunResponseSchema,
  queue_item: QueueItemResponseSchema,
});
export type ReconcileResponse = z.infer<typeof ReconcileResponseSchema>;

export const EmptyObjectRequestSchema = z.object({}).strict();

// --- Preferences ---
export const PreferencesResponseSchema = z.object({
  theme: z.enum(ThemePreferenceValues),
  sidebar_width: z.number().int(),
  send_shortcut: z.enum(SendShortcutPreferenceValues),
  revision: z.number().int().nonnegative(),
  updated_at: z.string(),
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
  expected_revision: z.number().int().nonnegative(),
});
export type PutPreferencesRequest = z.infer<typeof PutPreferencesRequestSchema>;
