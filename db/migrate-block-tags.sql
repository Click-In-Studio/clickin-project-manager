CREATE TABLE IF NOT EXISTS tag_group (
  id            TEXT        PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  type          TEXT        NOT NULL CHECK (type IN ('exclusive', 'range')),
  range_min     NUMERIC,
  range_max     NUMERIC,
  range_step    NUMERIC     DEFAULT 1,
  range_default NUMERIC,
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tag_option (
  id         TEXT    PRIMARY KEY,
  group_id   TEXT    NOT NULL REFERENCES tag_group(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT '#a1a1aa',
  sort_order INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE tag_group ADD COLUMN IF NOT EXISTS default_option_id TEXT REFERENCES tag_option(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS block_tag (
  block_id   TEXT        NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  group_id   TEXT        NOT NULL REFERENCES tag_group(id) ON DELETE CASCADE,
  option_id  TEXT        REFERENCES tag_option(id) ON DELETE SET NULL,
  value      NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (block_id, group_id)
);

CREATE INDEX IF NOT EXISTS block_tag_group_idx ON block_tag(group_id);
CREATE INDEX IF NOT EXISTS block_tag_block_idx ON block_tag(block_id);
