-- Run against click_in_agent database (as postgres superuser)

CREATE TABLE IF NOT EXISTS chat_memories (
  chat_id    TEXT        PRIMARY KEY,
  memory     TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_memories (
  sender_id  TEXT        PRIMARY KEY,
  memory     TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE ON chat_memories, user_memories TO agent_user;
