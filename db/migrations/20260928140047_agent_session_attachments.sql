-- migrate:up

CREATE TABLE agent_session_attachment (
  id          TEXT        PRIMARY KEY,
  session_id  TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  r2_key      TEXT        NOT NULL UNIQUE,
  file_name   TEXT        NOT NULL,
  mime_type   TEXT        NOT NULL,
  -- 模态与容器/MIME 正交：Safari 录音可能给 video/mp4，但业务模态仍是 audio。
  media_kind  TEXT        NULL CHECK (media_kind ~ '^[a-z][a-z0-9_-]*$'),
  file_size   BIGINT      NOT NULL CHECK (file_size >= 0),
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at    TIMESTAMPTZ NULL
);

CREATE INDEX agent_session_attachment_session_idx
  ON agent_session_attachment (session_id, created_at);

COMMENT ON TABLE agent_session_attachment IS
  'AI 会话私有的临时附件；不进入资产库，所有权与生命周期跟随 agent_session。';

-- migrate:down

DROP TABLE agent_session_attachment;
