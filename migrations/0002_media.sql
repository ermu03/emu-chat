-- Media control records. Image originals and capture jobs live in the Hermes plugin.
-- This migration is additive because existing deployment data must survive upgrades.

ALTER TABLE drafts ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(attachments_json) AND json_type(attachments_json) = 'array');

ALTER TABLE queue_items ADD COLUMN payload_attachments_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(payload_attachments_json) AND json_type(payload_attachments_json) = 'array');
ALTER TABLE queue_items ADD COLUMN media_state TEXT NOT NULL DEFAULT 'ready'
  CHECK (media_state IN ('pending', 'ready', 'failed'));
ALTER TABLE queue_items ADD COLUMN payload_run_input TEXT;

CREATE TABLE media_assets (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  status TEXT NOT NULL,
  source_json TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  capture_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, asset_id)
);

CREATE TABLE media_outbox (
  id TEXT NOT NULL PRIMARY KEY,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'register', 'reference_put', 'reference_delete', 'submission_bind',
    'scope_delete', 'grant', 'history_handoff', 'orphan_release'
  )),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'review')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_media_outbox_due ON media_outbox(status, next_attempt_at, created_at);

CREATE TABLE media_branch_pending (
  target_scope_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  source_scope_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  copied_message_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE media_branch_messages (
  target_scope_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  target_message_id INTEGER NOT NULL,
  asset_ids_json TEXT NOT NULL CHECK (json_valid(asset_ids_json)),
  source_operation_id TEXT,
  PRIMARY KEY(target_scope_id,target_message_id)
);
