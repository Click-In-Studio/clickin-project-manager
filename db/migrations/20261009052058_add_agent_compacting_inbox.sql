-- migrate:up

DROP INDEX IF EXISTS agent_run_active_idx;
ALTER TABLE agent_run DROP CONSTRAINT agent_run_status_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_status_check
  CHECK (status IN ('queued', 'running', 'compacting', 'awaiting_approval', 'awaiting_answer',
                    'completed', 'aborted', 'failed', 'interrupted'));
CREATE INDEX agent_run_active_idx
  ON agent_run (status, heartbeat_at)
  WHERE status IN ('running', 'compacting', 'awaiting_approval', 'awaiting_answer');

CREATE TABLE agent_session_inbox (
  id              TEXT        PRIMARY KEY,
  session_id      TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  claimed_run_id  TEXT        NULL REFERENCES agent_run(id) ON DELETE SET NULL,
  message         TEXT        NOT NULL,
  attachment_ids  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(attachment_ids) = 'array')
);

CREATE INDEX agent_session_inbox_pending_idx
  ON agent_session_inbox (session_id, created_at, id);

COMMENT ON TABLE agent_session_inbox IS
  '上下文压缩期间收到的用户输入；以 inbox id 作为 transcript entry id，消费后删除。';

-- migrate:down

DROP TABLE IF EXISTS agent_session_inbox;

DROP INDEX IF EXISTS agent_run_active_idx;
ALTER TABLE agent_run DROP CONSTRAINT agent_run_status_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_status_check
  CHECK (status IN ('queued', 'running', 'awaiting_approval', 'awaiting_answer',
                    'completed', 'aborted', 'failed', 'interrupted'));
CREATE INDEX agent_run_active_idx
  ON agent_run (status, heartbeat_at)
  WHERE status IN ('running', 'awaiting_approval', 'awaiting_answer');
