-- Run in click_in_agent DB: sudo -u postgres psql -d click_in_agent
-- Grant table access to agent_user after creation.

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_key  TEXT        PRIMARY KEY,
  messages     JSONB       NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT ALL PRIVILEGES ON TABLE agent_sessions TO agent_user;
