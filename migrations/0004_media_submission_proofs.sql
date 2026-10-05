-- Historical image verification survives queue/control retention without text.
CREATE TABLE media_submission_proofs (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL CHECK (substr(operation_id, 1, 3) = 'op_'),
  session_id TEXT NOT NULL,
  asset_ids_json TEXT NOT NULL CHECK (json_valid(asset_ids_json) AND json_type(asset_ids_json) = 'array'),
  user_text_sha256 TEXT NOT NULL CHECK (length(user_text_sha256) = 64),
  run_input_sha256 TEXT NOT NULL CHECK (length(run_input_sha256) = 64),
  queue_reference_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, operation_id)
);
