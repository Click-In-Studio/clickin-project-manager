-- migrate:up
CREATE TABLE agent_memory_scope (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  consumed_seq BIGINT NOT NULL DEFAULT 0,
  history_cutoff TIMESTAMPTZ NULL,
  UNIQUE (user_id, scope_key)
);
COMMENT ON TABLE agent_memory_scope IS '个人记忆作用域；空 scope_key 为通用，其他值为项目 id。修改/删除推进历史边界，不建立逐句来源图。';
CREATE TABLE agent_memory_entry (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES agent_memory_scope(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('dream','active')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  user_edited BOOLEAN NOT NULL DEFAULT false,
  revision BIGINT NOT NULL DEFAULT 0,
  input_count INTEGER NOT NULL DEFAULT 0 CHECK (input_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_memory_entry_scope_idx ON agent_memory_entry(scope_id);
ALTER TABLE agent_memory_chunk ADD COLUMN production_id TEXT NULL REFERENCES production(id) ON DELETE CASCADE;
ALTER TABLE agent_memory_chunk ADD COLUMN history_seq BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE agent_memory_chunk ADD COLUMN scope_known BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX agent_memory_chunk_history_idx ON agent_memory_chunk(scope_id, history_seq) WHERE source='episodic' AND scope_known;

-- 旧混合摘要不能作为个人通用事实继续注入。旧对话保留，由一次性回填补齐可信作用域。
DELETE FROM agent_memory_chunk WHERE source='curated';

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
