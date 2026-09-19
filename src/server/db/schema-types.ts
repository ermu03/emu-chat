export interface ConversationEntity {
  id: string; // cv_*
  hermes_profile: 'default';
  hermes_session_id: string;
  tags_json: string; // stringified JSON array
  custom_order: number | null;
  metadata_revision: number;
  queue_paused: 0 | 1;
  pause_reason: string | null;
  delete_state: 'none' | 'pending' | 'failed';
  delete_error_code: string | null;
  last_seen_upstream_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftEntity {
  conversation_id: string;
  content: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface QueueItemEntity {
  id: string; // qi_*
  conversation_id: string;
  operation_id: string; // op_*
  client_request_id: string;
  fifo_seq: number;
  state:
    | 'queued'
    | 'dispatching'
    | 'accepted'
    | 'reconciling'
    | 'done'
    | 'paused'
    | 'review_required'
    | 'rejected'
    | 'cancelled';
  payload_text: string | null;
  payload_sha256: string;
  payload_bytes: number;
  revision: number;
  idempotency_key: string;
  dispatch_session_id: string | null;
  attempt_count: number;
  first_attempt_at: string | null;
  admission_deadline_at: string | null;
  recovery_expires_at: string | null;
  payload_expired_at: string | null;
  payload_discarded_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunEntity {
  id: string; // lr_*
  queue_item_id: string;
  conversation_id: string;
  hermes_run_id: string | null;
  local_state:
    | 'submitting'
    | 'accepted'
    | 'reconciling'
    | 'reconciled'
    | 'rejected'
    | 'review_required';
  upstream_status:
    | 'queued'
    | 'running'
    | 'waiting_for_approval'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | null;
  partial: 0 | 1;
  last_event_seq: number;
  last_event_name: string | null;
  events_truncated: 0 | 1;
  last_error_code: string | null;
  last_status_checked_at: string | null;
  reconciliation_started_at: string | null;
  started_at: string;
  terminal_at: string | null;
  reconciled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CoordinatorLeaseEntity {
  scope_type: 'global' | 'conversation';
  scope_id: string;
  owner_id: string;
  lease_token: string;
  expires_at: string;
  heartbeat_at: string;
  created_at: string;
  updated_at: string;
}

export interface UiPreferencesEntity {
  id: 1;
  theme: 'system' | 'light' | 'dark';
  sidebar_width: number;
  send_shortcut: 'enter' | 'mod_enter';
  revision: number;
  updated_at: string;
}
