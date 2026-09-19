export const ConnectionStatusHermesValues = [
  'checking',
  'healthy',
  'degraded',
  'unavailable',
  'auth_failed',
  'incompatible',
  'config_error'
] as const;
export type ConnectionStatusHermes = (typeof ConnectionStatusHermesValues)[number];

export const PauseReasonValues = [
  'run_failed',
  'run_partial',
  'run_cancelled',
  'run_interrupted',
  'user_stopped',
  'submission_rejected',
  'reconciliation_failed',
  'review_required',
  'manual_resume_required'
] as const;
export type PauseReason = (typeof PauseReasonValues)[number];

export const QueueItemStateValues = [
  'queued',
  'dispatching',
  'accepted',
  'reconciling',
  'done',
  'paused',
  'review_required',
  'rejected',
  'cancelled'
] as const;
export type QueueItemState = (typeof QueueItemStateValues)[number];

export const RunLocalStateValues = [
  'submitting',
  'accepted',
  'reconciling',
  'reconciled',
  'rejected',
  'review_required'
] as const;
export type RunLocalState = (typeof RunLocalStateValues)[number];

export const UpstreamRunStatusValues = [
  'queued',
  'running',
  'waiting_for_approval',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
] as const;
export type UpstreamRunStatus = (typeof UpstreamRunStatusValues)[number];

export const DeleteStateValues = ['none', 'pending', 'failed'] as const;
export type DeleteState = (typeof DeleteStateValues)[number];

export const ApprovalChoiceValues = ['once', 'deny'] as const;
export type ApprovalChoice = (typeof ApprovalChoiceValues)[number];

export const ThemePreferenceValues = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof ThemePreferenceValues)[number];

export const SendShortcutPreferenceValues = ['enter', 'mod_enter'] as const;
export type SendShortcutPreference = (typeof SendShortcutPreferenceValues)[number];

export const ErrorCodeValues = [
  'INVALID_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'LOCAL_NOT_FOUND',
  'HERMES_NOT_FOUND',
  'DRAFT_CONFLICT',
  'LOCAL_CONFLICT',
  'STATE_CONFLICT',
  'RUN_ACTIVE',
  'APPROVAL_NOT_PENDING',
  'REVIEW_REQUIRED',
  'HERMES_NOT_READY',
  'HERMES_AUTH_FAILED',
  'HERMES_UNAVAILABLE',
  'HERMES_CONFLICT',
  'HERMES_TEMPORARY_FAILURE',
  'HERMES_PROTOCOL_ERROR',
  'HERMES_BUSY_GLOBAL',
  'DELETE_UNCONFIRMED',
  'INTERNAL_ERROR'
] as const;
export type ErrorCode = (typeof ErrorCodeValues)[number];

export const StreamGapReasonValues = [
  'buffer_evicted',
  'process_restarted',
  'upstream_disconnected',
  'protocol_error',
  'cursor_ahead'
] as const;
export type StreamGapReason = (typeof StreamGapReasonValues)[number];

export const MessageRoleValues = ['user', 'assistant', 'tool', 'system'] as const;
export type MessageRole = (typeof MessageRoleValues)[number];
