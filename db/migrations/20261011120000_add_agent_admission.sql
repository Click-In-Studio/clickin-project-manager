-- migrate:up
ALTER TABLE agent_run
  ADD COLUMN admission_class TEXT NOT NULL DEFAULT 'interactive'
    CHECK (admission_class IN ('interactive','subagent','schedule')),
  ADD COLUMN execution_epoch INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN input_wait JSONB;

UPDATE agent_run SET admission_class=CASE
  WHEN subagent_id IS NOT NULL THEN 'subagent'
  WHEN schedule_id IS NOT NULL THEN 'schedule' ELSE 'interactive' END;

CREATE TABLE agent_admission (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource IN ('context','llm','local_tool','mmp')),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','active','done','failed','unknown')),
  ready_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  owner TEXT,
  heartbeat_at TIMESTAMPTZ,
  remote_id TEXT,
  result JSONB,
  UNIQUE(run_id,operation_key)
);
CREATE INDEX agent_admission_ready_idx ON agent_admission(resource,ready_at,id) WHERE state='ready';
CREATE INDEX agent_admission_active_idx ON agent_admission(resource) WHERE state IN ('active','unknown');
CREATE UNIQUE INDEX agent_run_primary_pending_idx ON agent_run(session_id)
  WHERE subagent_id IS NULL AND status='queued';

CREATE TABLE agent_tool_operation (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  execution_epoch INTEGER NOT NULL,
  result JSONB,
  UNIQUE(run_id,tool_call_id)
);

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
