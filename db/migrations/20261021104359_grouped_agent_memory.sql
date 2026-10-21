-- migrate:up
-- 退出无法继续核对项目依赖的通用自动摘要；用户编辑与个人项目条目保留。
DELETE FROM agent_memory_entry e USING agent_memory_scope s
WHERE e.scope_id=s.id AND s.production_id IS NULL AND cardinality(s.dream_project_ids)>0
  AND e.source='dream' AND NOT e.user_edited;

CREATE TABLE agent_memory_group (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES agent_memory_scope(id) ON DELETE CASCADE,
  member_count INTEGER NOT NULL DEFAULT 1 CHECK(member_count>=0),
  context_chars INTEGER NOT NULL DEFAULT 0 CHECK(context_chars>=0),
  in_cache BOOLEAN NOT NULL DEFAULT true,
  last_touched_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revision BIGINT NOT NULL DEFAULT 0,
  summary TEXT NULL CHECK(length(summary)<=4000),
  summary_revision BIGINT NULL,
  UNIQUE(scope_id,id)
);
CREATE INDEX agent_memory_group_lru_idx ON agent_memory_group(scope_id,last_touched_at,id) WHERE in_cache;
ALTER TABLE agent_memory_entry ADD COLUMN group_id TEXT;
ALTER TABLE agent_memory_entry ADD COLUMN brief TEXT;
ALTER TABLE agent_memory_entry ADD COLUMN created_at TIMESTAMPTZ;
ALTER TABLE agent_memory_entry ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE agent_memory_entry ADD COLUMN organized_revision BIGINT NOT NULL DEFAULT -1;
ALTER TABLE agent_memory_entry ADD COLUMN organization_checked_at TIMESTAMPTZ;
ALTER TABLE agent_memory_entry ADD COLUMN embedding vector(1024);
ALTER TABLE agent_memory_entry ADD COLUMN embedding_model TEXT;
ALTER TABLE agent_memory_entry ADD COLUMN embedding_revision BIGINT;
INSERT INTO agent_memory_group(id,scope_id,context_chars,last_touched_at)
SELECT 'mg_'||id,scope_id,length(left(body,300))+400,updated_at FROM agent_memory_entry;
UPDATE agent_memory_entry SET group_id='mg_'||id,brief=left(body,300),created_at=updated_at,source='active';
ALTER TABLE agent_memory_entry ALTER COLUMN brief SET NOT NULL;
ALTER TABLE agent_memory_entry ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE agent_memory_entry ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE agent_memory_entry DROP CONSTRAINT agent_memory_entry_source_check;
ALTER TABLE agent_memory_entry ADD CONSTRAINT agent_memory_entry_source_check CHECK(source='active');
ALTER TABLE agent_memory_entry DROP COLUMN input_count;
ALTER TABLE agent_memory_entry ADD CONSTRAINT agent_memory_entry_scope_id_id_key UNIQUE(scope_id,id);
ALTER TABLE agent_memory_entry ADD CONSTRAINT agent_memory_entry_group_fk FOREIGN KEY(scope_id,group_id) REFERENCES agent_memory_group(scope_id,id);
ALTER TABLE agent_memory_entry ADD CONSTRAINT agent_memory_entry_live_group_check CHECK((deleted_at IS NULL)=(group_id IS NOT NULL));
ALTER TABLE agent_memory_entry ADD CONSTRAINT agent_memory_entry_brief_check CHECK(length(brief) BETWEEN 1 AND 300);
CREATE INDEX agent_memory_entry_group_idx ON agent_memory_entry(scope_id,group_id,id) WHERE deleted_at IS NULL;
CREATE INDEX agent_memory_entry_embedding_idx ON agent_memory_entry USING hnsw(embedding vector_cosine_ops) WHERE deleted_at IS NULL;
CREATE INDEX agent_memory_entry_pending_idx ON agent_memory_entry(scope_id,updated_at,id) WHERE deleted_at IS NULL AND organized_revision<>revision;

CREATE TABLE agent_memory_relation (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES agent_memory_scope(id) ON DELETE CASCADE,
  left_entry_id TEXT NOT NULL,
  right_entry_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('duplicate','conflict')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  left_revision BIGINT NOT NULL,
  right_revision BIGINT NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(left_entry_id<right_entry_id),
  UNIQUE(scope_id,left_entry_id,right_entry_id),
  FOREIGN KEY(scope_id,left_entry_id) REFERENCES agent_memory_entry(scope_id,id) ON DELETE CASCADE,
  FOREIGN KEY(scope_id,right_entry_id) REFERENCES agent_memory_entry(scope_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_memory_relation_right_idx ON agent_memory_relation(scope_id,right_entry_id);
ALTER TABLE agent_memory_scope DROP COLUMN consumed_seq;
ALTER TABLE agent_memory_scope DROP COLUMN dream_project_ids;
COMMENT ON TABLE agent_memory_scope IS '个人通用或个人项目长期记忆；内容修订与历史截断由服务端维护。';

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
