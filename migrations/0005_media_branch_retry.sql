-- Keep pending branch ownership work retryable while a target deletion is temporary.
ALTER TABLE media_branch_pending ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT '';
CREATE INDEX ix_media_branch_due ON media_branch_pending(status, next_attempt_at, created_at);

-- Recheck previously completed descendant branches: older code skipped inherited mappings.
-- Only a still-registered direct source can safely authorize the repair.
WITH RECURSIVE repair(target_scope_id) AS (
  SELECT b.target_scope_id FROM media_branch_pending b
  WHERE b.copied_message_count>0
    AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=b.source_scope_id)
    AND EXISTS (SELECT 1 FROM media_branch_messages m WHERE m.target_scope_id=b.source_scope_id)
  UNION
  SELECT b.target_scope_id FROM media_branch_pending b
  JOIN repair r ON r.target_scope_id=b.source_scope_id
  WHERE b.copied_message_count>0
)
UPDATE media_branch_pending SET status='pending', last_error=NULL, next_attempt_at=''
WHERE status='done' AND target_scope_id IN (SELECT target_scope_id FROM repair);
