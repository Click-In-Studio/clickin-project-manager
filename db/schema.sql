-- Script Editor schema
-- Run against: script_editor database

CREATE TABLE production (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scene (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  num           TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX scene_production_idx ON scene(production_id, sort_order);

CREATE TABLE character (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX character_production_idx ON character(production_id, sort_order);

CREATE TYPE block_type AS ENUM ('dialogue', 'stage', 'lyric');

CREATE TABLE script (
  id              TEXT PRIMARY KEY,
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  sort_key        TEXT NOT NULL,        -- base-36 lex order key, 10 chars
  scene_id        TEXT REFERENCES scene(id) ON DELETE SET NULL,
  rehearsal_mark  TEXT,
  type            block_type NOT NULL DEFAULT 'dialogue',
  content         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX script_production_sort_idx ON script(production_id, sort_key);

-- Junction table: which characters speak in each block, in order
CREATE TABLE script_character (
  script_id    TEXT NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (script_id, character_id)
);
