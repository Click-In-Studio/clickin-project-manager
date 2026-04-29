-- Run against click_in_agent as postgres superuser
\c click_in_agent

-- Allow rows without production context (e.g. task anchor set before focus_production)
ALTER TABLE agent_chat_context
  ALTER COLUMN production_id   DROP NOT NULL,
  ALTER COLUMN production_name DROP NOT NULL;

ALTER TABLE agent_chat_context
  ADD COLUMN IF NOT EXISTS task_anchor JSONB;

GRANT SELECT, INSERT, UPDATE ON agent_chat_context TO agent_user;
