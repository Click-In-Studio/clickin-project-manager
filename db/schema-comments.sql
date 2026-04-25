CREATE TABLE block_comment (
  id          TEXT        PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  production_id TEXT      NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  block_id    TEXT        NOT NULL,
  open_id     TEXT        NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  author_name TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON block_comment(production_id);
CREATE INDEX ON block_comment(production_id, block_id);
