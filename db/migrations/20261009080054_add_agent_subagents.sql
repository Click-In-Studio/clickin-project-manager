-- migrate:up
ALTER TABLE agent_session ADD COLUMN parent_session_id TEXT REFERENCES agent_session(id) ON DELETE CASCADE;
CREATE INDEX agent_session_parent_idx ON agent_session(parent_session_id) WHERE parent_session_id IS NOT NULL;
ALTER TABLE agent_session_inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'user_message'
  CHECK (kind IN ('user_message', 'subagent_event'));
ALTER TABLE agent_session_inbox ADD COLUMN payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_run ADD COLUMN budget_run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL;
ALTER TABLE agent_run ADD COLUMN paid_from TEXT CHECK (paid_from IN ('quota','extra','exempt'));
ALTER TABLE agent_run ADD COLUMN task_credits BIGINT NOT NULL DEFAULT 0;

CREATE TABLE agent_subagent (
  id TEXT PRIMARY KEY REFERENCES agent_session(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  completion_criteria TEXT NOT NULL DEFAULT '',
  sources JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  stopped BOOLEAN NOT NULL DEFAULT false,
  context_request TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE agent_run ADD COLUMN subagent_id TEXT REFERENCES agent_subagent(id) ON DELETE CASCADE;
ALTER TABLE agent_run ADD COLUMN initial_message TEXT;
ALTER TABLE agent_run ADD COLUMN delegation_key TEXT UNIQUE;
ALTER TABLE agent_run ADD COLUMN result TEXT;
ALTER TABLE agent_run ADD COLUMN execution_started_at TIMESTAMPTZ;
ALTER TABLE agent_run ADD COLUMN notification_delivered BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX agent_run_subagent_queue_idx ON agent_run(started_at, id)
  WHERE subagent_id IS NOT NULL AND status = 'queued';
CREATE UNIQUE INDEX agent_run_single_writer_idx ON agent_run(session_id)
  WHERE status IN ('running', 'compacting', 'awaiting_approval', 'awaiting_answer');

CREATE TABLE agent_subagent_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE
);

-- migrate:down
DROP TABLE agent_subagent_usage;
DROP INDEX agent_run_single_writer_idx;
DROP INDEX agent_run_subagent_queue_idx;
ALTER TABLE agent_run DROP COLUMN notification_delivered, DROP COLUMN execution_started_at,
  DROP COLUMN result, DROP COLUMN delegation_key, DROP COLUMN initial_message, DROP COLUMN subagent_id;
DROP TABLE agent_subagent;
DROP INDEX agent_session_parent_idx;
ALTER TABLE agent_session DROP COLUMN parent_session_id;
ALTER TABLE agent_run DROP COLUMN paid_from, DROP COLUMN task_credits, DROP COLUMN budget_run_id;
ALTER TABLE agent_session_inbox DROP COLUMN payload, DROP COLUMN kind;
