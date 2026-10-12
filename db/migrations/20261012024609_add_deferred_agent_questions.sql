-- migrate:up
ALTER TABLE agent_question
  ADD COLUMN wait_mode TEXT NOT NULL DEFAULT 'required'
    CHECK (wait_mode IN ('required', 'continue_independent')),
  ADD COLUMN continuation JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN cancellation_reason TEXT,
  ALTER COLUMN expires_at DROP NOT NULL;

CREATE UNIQUE INDEX agent_question_session_tool_call_idx
  ON agent_question (session_id, tool_call_id);

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_question WHERE expires_at IS NULL) THEN
    RAISE EXCEPTION 'irreversible: deferred agent questions exist';
  END IF;
END $$;
DROP INDEX agent_question_session_tool_call_idx;
ALTER TABLE agent_question
  ALTER COLUMN expires_at SET NOT NULL,
  DROP COLUMN cancellation_reason,
  DROP COLUMN continuation,
  DROP COLUMN wait_mode;

