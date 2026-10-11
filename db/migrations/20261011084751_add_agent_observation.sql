-- migrate:up
-- 新运行的最小性能观测；不保存用户输入、对话或记忆正文。
CREATE TABLE IF NOT EXISTS agent_observation (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES agent_run(id) ON DELETE CASCADE,
  user_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('model_request','tool_retrieval','memory_retrieval','compaction_check')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  elapsed_ms DOUBLE PRECISION,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_observation_run_idx ON agent_observation(run_id,started_at);
CREATE INDEX IF NOT EXISTS agent_observation_kind_idx ON agent_observation(kind,started_at);

-- migrate:down
DROP TABLE IF EXISTS agent_observation;
