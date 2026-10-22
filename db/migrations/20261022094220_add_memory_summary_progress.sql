-- migrate:up
ALTER TABLE agent_memory_group ADD COLUMN summary_progress JSONB;

-- migrate:down
ALTER TABLE agent_memory_group DROP COLUMN summary_progress;
