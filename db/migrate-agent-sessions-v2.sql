-- Run in click_in_agent DB: sudo -u postgres psql -d click_in_agent
-- Adds ctx_snapshot column to store enough BotContext for button-click replay.

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS ctx_snapshot JSONB NOT NULL DEFAULT '{}';
