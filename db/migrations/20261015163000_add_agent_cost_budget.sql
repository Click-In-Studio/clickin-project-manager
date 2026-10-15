-- migrate:up
ALTER TABLE agent_run ADD COLUMN task_budget_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_admission ADD COLUMN reserved_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_admission ADD COLUMN charged_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_admission ADD COLUMN reservation_id TEXT;
ALTER TABLE agent_tool_operation ADD COLUMN progress_key TEXT;
ALTER TABLE agent_tool_operation ADD COLUMN input_entry_id TEXT;
ALTER TABLE agent_tool_operation ADD COLUMN completed_at TIMESTAMPTZ;
CREATE INDEX agent_tool_operation_progress_idx ON agent_tool_operation(run_id,completed_at DESC) WHERE progress_key IS NOT NULL;

-- migrate:down
DROP INDEX agent_tool_operation_progress_idx;
ALTER TABLE agent_tool_operation DROP COLUMN completed_at;
ALTER TABLE agent_tool_operation DROP COLUMN input_entry_id;
ALTER TABLE agent_tool_operation DROP COLUMN progress_key;
ALTER TABLE agent_admission DROP COLUMN reservation_id;
ALTER TABLE agent_admission DROP COLUMN charged_credits;
ALTER TABLE agent_admission DROP COLUMN reserved_credits;
ALTER TABLE agent_run DROP COLUMN task_budget_credits;
