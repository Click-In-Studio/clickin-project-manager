-- migrate:up

ALTER TABLE agent_session_attachment
  ADD COLUMN source_kind TEXT NULL
    CHECK (source_kind IS NULL OR source_kind = 'web_fetch'),
  ADD COLUMN source_run_id TEXT NULL,
  ADD COLUMN source_tool_call_id TEXT NULL,
  ADD COLUMN source_url TEXT NULL,
  ADD COLUMN source_final_url TEXT NULL,
  ADD CONSTRAINT agent_session_attachment_web_fetch_source_check CHECK (
    source_kind IS NULL OR (
      source_run_id IS NOT NULL
      AND source_tool_call_id IS NOT NULL
      AND source_url IS NOT NULL
      AND source_final_url IS NOT NULL
    )
  );

CREATE UNIQUE INDEX agent_session_attachment_web_fetch_call_idx
  ON agent_session_attachment (source_run_id, source_tool_call_id)
  WHERE source_kind = 'web_fetch' AND status IN ('pending', 'ready');

CREATE UNIQUE INDEX agent_session_attachment_web_fetch_url_idx
  ON agent_session_attachment (source_run_id, source_final_url)
  WHERE source_kind = 'web_fetch' AND status IN ('pending', 'ready');

COMMENT ON COLUMN agent_session_attachment.source_run_id IS
  '创建远端附件的 Agent run；不设 FK，避免 run 清理时抹掉附件来源审计。';
COMMENT ON COLUMN agent_session_attachment.source_tool_call_id IS
  '创建远端附件的工具调用 id；用于历史工具气泡关联与同一调用重放幂等。';
COMMENT ON COLUMN agent_session_attachment.source_url IS
  'web.fetch 用户或模型请求的原始公开 URL。';
COMMENT ON COLUMN agent_session_attachment.source_final_url IS
  'web.fetch 完成公开重定向后的最终 URL；同一 run 内据此去重。';

-- migrate:down

DROP INDEX IF EXISTS agent_session_attachment_web_fetch_url_idx;
DROP INDEX IF EXISTS agent_session_attachment_web_fetch_call_idx;

ALTER TABLE agent_session_attachment
  DROP CONSTRAINT IF EXISTS agent_session_attachment_web_fetch_source_check,
  DROP COLUMN IF EXISTS source_final_url,
  DROP COLUMN IF EXISTS source_url,
  DROP COLUMN IF EXISTS source_tool_call_id,
  DROP COLUMN IF EXISTS source_run_id,
  DROP COLUMN IF EXISTS source_kind;
