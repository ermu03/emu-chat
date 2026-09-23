-- 0001_initial.sql
-- Initial emu-chat local control schema.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT NOT NULL PRIMARY KEY CHECK (substr(id, 1, 3) = 'cv_'),
  hermes_profile TEXT NOT NULL DEFAULT 'default'
    CHECK (hermes_profile = 'default'),
  hermes_session_id TEXT NOT NULL UNIQUE,
  tags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  custom_order REAL,
  metadata_revision INTEGER NOT NULL DEFAULT 0
    CHECK (metadata_revision >= 0),
  queue_paused INTEGER NOT NULL DEFAULT 0
    CHECK (queue_paused IN (0, 1)),
  pause_reason TEXT CHECK (
    pause_reason IS NULL OR pause_reason IN (
      'run_failed', 'run_partial', 'run_cancelled', 'run_interrupted',
      'user_stopped', 'submission_rejected',
      'reconciliation_failed', 'review_required',
      'manual_resume_required'
    )
  ),
  delete_state TEXT NOT NULL DEFAULT 'none'
    CHECK (delete_state IN ('none', 'pending', 'failed')),
  delete_error_code TEXT,
  last_seen_upstream_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((queue_paused = 0 AND pause_reason IS NULL)
      OR (queue_paused = 1 AND pause_reason IS NOT NULL))
);

CREATE TABLE drafts (
  conversation_id TEXT NOT NULL PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE queue_items (
  id TEXT NOT NULL PRIMARY KEY CHECK (substr(id, 1, 3) = 'qi_'),
  conversation_id TEXT NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE
    CHECK (substr(operation_id, 1, 3) = 'op_'),
  client_request_id TEXT NOT NULL UNIQUE,
  fifo_seq INTEGER NOT NULL CHECK (fifo_seq > 0),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'dispatching', 'accepted', 'reconciling', 'done',
    'paused', 'review_required', 'rejected', 'cancelled'
  )),
  payload_text TEXT,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  dispatch_session_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 4),
  first_attempt_at TEXT,
  admission_deadline_at TEXT,
  recovery_expires_at TEXT,
  payload_expired_at TEXT,
  payload_discarded_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, conversation_id),
  UNIQUE (conversation_id, fifo_seq),
  CHECK (state <> 'queued' OR dispatch_session_id IS NULL),
  CHECK (state NOT IN ('dispatching', 'accepted', 'reconciling', 'done', 'paused')
         OR dispatch_session_id IS NOT NULL),
  CHECK (state NOT IN ('queued', 'dispatching', 'accepted', 'reconciling')
         OR payload_text IS NOT NULL),
  CHECK (state NOT IN ('done', 'cancelled') OR payload_text IS NULL)
);

CREATE UNIQUE INDEX ux_queue_one_global_active
  ON queue_items ((1))
  WHERE state IN ('dispatching', 'accepted', 'reconciling');

CREATE UNIQUE INDEX ux_queue_one_conversation_active
  ON queue_items (conversation_id)
  WHERE state IN ('dispatching', 'accepted', 'reconciling');

CREATE INDEX ix_queue_fifo
  ON queue_items (conversation_id, state, fifo_seq);

CREATE INDEX ix_queue_recovery_expiry
  ON queue_items (recovery_expires_at)
  WHERE payload_text IS NOT NULL AND recovery_expires_at IS NOT NULL;

CREATE INDEX ix_queue_control_retention
  ON queue_items (updated_at)
  WHERE state IN ('done', 'cancelled', 'paused', 'rejected');

CREATE TABLE runs (
  id TEXT NOT NULL PRIMARY KEY CHECK (substr(id, 1, 3) = 'lr_'),
  queue_item_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  hermes_run_id TEXT UNIQUE,
  local_state TEXT NOT NULL CHECK (local_state IN (
    'submitting', 'accepted', 'reconciling', 'reconciled',
    'rejected', 'review_required'
  )),
  upstream_status TEXT CHECK (
    upstream_status IS NULL OR upstream_status IN (
      'queued', 'running', 'waiting_for_approval', 'stopping',
      'completed', 'failed', 'cancelled', 'interrupted'
    )
  ),
  partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  last_event_name TEXT,
  events_truncated INTEGER NOT NULL DEFAULT 0 CHECK (events_truncated IN (0, 1)),
  last_error_code TEXT,
  last_status_checked_at TEXT,
  reconciliation_started_at TEXT,
  started_at TEXT NOT NULL,
  terminal_at TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (queue_item_id, conversation_id)
    REFERENCES queue_items(id, conversation_id) ON DELETE CASCADE,
  CHECK (local_state NOT IN ('accepted', 'reconciling', 'reconciled')
         OR hermes_run_id IS NOT NULL),
  CHECK (local_state NOT IN ('submitting', 'rejected')
         OR hermes_run_id IS NULL),
  CHECK (hermes_run_id IS NOT NULL OR upstream_status IS NULL)
);

CREATE INDEX ix_runs_hermes_status
  ON runs (upstream_status, local_state);

CREATE TABLE coordinator_leases (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'conversation')),
  scope_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_id),
  CHECK ((scope_type = 'global' AND scope_id = 'global')
      OR (scope_type = 'conversation' AND substr(scope_id, 1, 3) = 'cv_'))
);

CREATE TABLE ui_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'system'
    CHECK (theme IN ('system', 'light', 'dark')),
  sidebar_width INTEGER NOT NULL DEFAULT 320
    CHECK (sidebar_width BETWEEN 240 AND 520),
  send_shortcut TEXT NOT NULL DEFAULT 'enter'
    CHECK (send_shortcut IN ('enter', 'mod_enter')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO ui_preferences (
  id, theme, sidebar_width, send_shortcut, revision, updated_at
) VALUES (1, 'system', 320, 'enter', 0, '1970-01-01T00:00:00.000Z');
