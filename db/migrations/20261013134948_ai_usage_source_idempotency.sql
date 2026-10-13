-- migrate:up
ALTER TABLE ai_usage ADD COLUMN source_id TEXT NULL;
CREATE UNIQUE INDEX ai_usage_kind_source_idx ON ai_usage (kind, source_id) WHERE source_id IS NOT NULL;
COMMENT ON COLUMN ai_usage.source_id IS
  '外部计费事实的稳定身份；MMP 使用远端 job id，恢复或重放时据此只记一次。';


-- migrate:down
DROP INDEX IF EXISTS ai_usage_kind_source_idx;
ALTER TABLE ai_usage DROP COLUMN source_id;

