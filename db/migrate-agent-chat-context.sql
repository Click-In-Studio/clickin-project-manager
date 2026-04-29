-- Run against click_in_agent as postgres superuser
\c click_in_agent

CREATE TABLE IF NOT EXISTS agent_chat_context (
  chat_id         TEXT PRIMARY KEY,
  production_id   TEXT NOT NULL,
  production_name TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE ON agent_chat_context TO agent_user;
