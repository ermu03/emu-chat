-- 0001_initial.sql
-- emu-chat initial schema

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  hermes_session_id TEXT NOT NULL,
  fork_parent_session_id TEXT,
  title TEXT NOT NULL,
  custom_order INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  tags_json TEXT NOT NULL DEFAULT '[]',
  last_active INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT NOT NULL DEFAULT '',
  active_run_id TEXT,
  queue_paused INTEGER NOT NULL DEFAULT 0 CHECK (queue_paused IN (0, 1)),
  pause_reason TEXT CHECK (pause_reason IN (
    'run_failed', 'run_partial', 'run_cancelled', 'run_interrupted',
    'user_stopped', 'submission_rejected', 'reconciliation_failed',
    'review_required', 'manual_resume_required'
  )),
  delete_state TEXT NOT NULL DEFAULT 'none' CHECK (delete_state IN ('none', 'pending', 'failed')),
  delete_requested_at TEXT,
  delete_failed_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_hermes_session
  ON conversations(hermes_session_id);

CREATE TABLE IF NOT EXISTS drafts (
  conversation_id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS queue_items (
  queue_item_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'dispatching', 'accepted', 'reconciling',
    'done', 'paused', 'review_required', 'rejected', 'cancelled'
  )),
  has_payload INTEGER NOT NULL DEFAULT 1 CHECK (has_payload IN (0, 1)),
  payload_preview TEXT NOT NULL,
  current_local_run_id TEXT,
  pause_reason TEXT CHECK (pause_reason IN (
    'run_failed', 'run_partial', 'run_cancelled', 'run_interrupted',
    'user_stopped', 'submission_rejected', 'reconciliation_failed',
    'review_required', 'manual_resume_required'
  )),
  review_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_conversation_position
  ON queue_items(conversation_id, position);

CREATE TABLE IF NOT EXISTS queue_recovery_payloads (
  queue_item_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (queue_item_id) REFERENCES queue_items(queue_item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  local_run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  queue_item_id TEXT NOT NULL,
  hermes_run_id TEXT,
  effective_hermes_session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'submitting', 'accepted', 'reconciling', 'reconciled', 'rejected', 'review_required'
  )),
  upstream_status TEXT CHECK (upstream_status IN (
    'queued', 'running', 'waiting_for_approval', 'stopping',
    'completed', 'failed', 'cancelled', 'interrupted'
  )),
  admission_attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT,
  turn_exit_reason TEXT,
  pending_steer INTEGER NOT NULL DEFAULT 0 CHECK (pending_steer IN (0, 1)),
  waiting_approval_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (queue_item_id) REFERENCES queue_items(queue_item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_conversation
  ON runs(conversation_id);

CREATE TABLE IF NOT EXISTS ui_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  sidebar_width INTEGER NOT NULL DEFAULT 320,
  send_shortcut TEXT NOT NULL DEFAULT 'enter' CHECK (send_shortcut IN ('enter', 'mod_enter')),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_request_dedup (
  client_request_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  queue_item_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admission_leases (
  lease_key TEXT PRIMARY KEY CHECK (lease_key IN ('global_run_submission', 'reconciliation_runner')),
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_log (
  op_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  op_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Seed single row for ui_preferences if not exists
INSERT OR IGNORE INTO ui_preferences (id, theme, sidebar_width, send_shortcut, revision, updated_at)
VALUES (1, 'system', 320, 'enter', 1, datetime('now'));
