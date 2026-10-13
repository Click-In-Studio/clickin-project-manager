-- migrate:up
ALTER TABLE agent_session_attachment
  DROP CONSTRAINT agent_session_attachment_source_kind_check,
  DROP CONSTRAINT agent_session_attachment_web_fetch_source_check;

ALTER TABLE agent_session_attachment
  ADD COLUMN source_output_name TEXT NULL,
  ADD COLUMN source_output_index INTEGER NULL CHECK (source_output_index IS NULL OR source_output_index >= 0),
  ADD COLUMN source_metadata JSONB NULL,
  ADD CONSTRAINT agent_session_attachment_source_kind_check
    CHECK (source_kind IS NULL OR source_kind IN ('web_fetch', 'mmp')),
  ADD CONSTRAINT agent_session_attachment_source_check CHECK (
    source_kind IS NULL OR
    (source_kind = 'web_fetch'
      AND source_run_id IS NOT NULL AND source_tool_call_id IS NOT NULL
      AND source_url IS NOT NULL AND source_final_url IS NOT NULL
      AND source_output_name IS NULL AND source_output_index IS NULL) OR
    (source_kind = 'mmp'
      AND source_run_id IS NOT NULL AND source_tool_call_id IS NOT NULL
      AND source_url IS NULL AND source_final_url IS NULL
      AND source_output_name IS NOT NULL AND source_output_index IS NOT NULL
      AND source_metadata IS NOT NULL)
  );

CREATE UNIQUE INDEX agent_session_attachment_mmp_output_idx
  ON agent_session_attachment (source_run_id, source_tool_call_id, source_output_name, source_output_index)
  WHERE source_kind = 'mmp' AND status IN ('pending', 'ready');

COMMENT ON COLUMN agent_session_attachment.source_output_name IS
  'MMP capability 的命名 media output；与 output_index 一起定位同一 tool call 的产物。';
COMMENT ON COLUMN agent_session_attachment.source_output_index IS
  'MMP media output 内的零基下标；单值输出固定为 0。';
COMMENT ON COLUMN agent_session_attachment.source_metadata IS
  '不含凭据的远端产物来源与校验元数据；当前用于 MMP job/capability/engine/digest。';


-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'irreversible: mmp generated attachments cannot be represented by the previous source contract';
END $$;

