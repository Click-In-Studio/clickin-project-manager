-- Agent Bot database setup
-- Run once as the postgres superuser before starting the application.
--
-- Usage:
--   sudo -u postgres psql -f db/setup-agent-db.sql
--
-- Replace CHANGE_ME with a strong password before running.
-- After running, set AGENT_PGPASSWORD in .env.local to the same value.

CREATE DATABASE click_in_agent;
CREATE USER agent_user WITH PASSWORD 'CHANGE_ME';
GRANT ALL PRIVILEGES ON DATABASE click_in_agent TO agent_user;

\connect click_in_agent

-- ── Agent tables ──────────────────────────────────────────────────────────────

-- Per-chat context: tracks which production the bot is currently helping with
-- and any active task anchor (e.g. an event being planned).
CREATE TABLE IF NOT EXISTS agent_chat_context (
  chat_id         TEXT PRIMARY KEY,
  production_id   TEXT,
  production_name TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_anchor     JSONB
);

-- Short-lived conversation sessions keyed by chat_id + user combo.
-- ctx_snapshot holds a frozen snapshot of the BotContext at session start.
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_key  TEXT PRIMARY KEY,
  messages     JSONB NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ctx_snapshot JSONB NOT NULL DEFAULT '{}'
);

-- Long-term memory scoped to a specific chat (group context).
CREATE TABLE IF NOT EXISTS chat_memories (
  chat_id    TEXT PRIMARY KEY,
  memory     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Long-term memory scoped to an individual user (cross-chat, cross-platform).
-- Keyed by internal app_user UUID so memory is shared across Feishu, future platforms, etc.
CREATE TABLE IF NOT EXISTS user_memories (
  user_id    TEXT PRIMARY KEY,
  memory     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
