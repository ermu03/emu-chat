-- Preserve existing data while supporting stable local-registry pagination.
CREATE INDEX ix_conversations_list_order
  ON conversations(custom_order ASC, created_at DESC, id ASC);
