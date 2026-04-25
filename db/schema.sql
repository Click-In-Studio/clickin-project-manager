-- Script Editor — full schema
-- Idempotent: safe to run on an existing database.
-- Run as: psql -d script_editor -f schema.sql

-- ── Enum ──────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE block_type AS ENUM ('dialogue', 'stage', 'lyric');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Core tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scene (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  num           TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS scene_production_idx ON scene(production_id, sort_order);

CREATE TABLE IF NOT EXISTS character (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS character_production_idx ON character(production_id, sort_order);

CREATE TABLE IF NOT EXISTS script (
  id              TEXT PRIMARY KEY,
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  sort_key        TEXT NOT NULL,
  scene_id        TEXT REFERENCES scene(id) ON DELETE SET NULL,
  rehearsal_mark  TEXT,
  type            block_type NOT NULL DEFAULT 'dialogue',
  content         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS script_production_sort_idx ON script(production_id, sort_key);

CREATE TABLE IF NOT EXISTS script_character (
  script_id    TEXT NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (script_id, character_id)
);

-- ── Auth ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feishu_user (
  open_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  avatar_url     TEXT,
  email          TEXT,
  phone          TEXT,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS production_member (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  roles         TEXT[] NOT NULL DEFAULT '{}',
  photo_url     TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (production_id, open_id)
);

-- ── Comments ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS block_comment (
  id            TEXT        PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  block_id      TEXT        NOT NULL,
  open_id       TEXT        NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  author_name   TEXT        NOT NULL,
  content       TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS block_comment_production_idx ON block_comment(production_id);
CREATE INDEX IF NOT EXISTS block_comment_block_idx ON block_comment(production_id, block_id);

-- ── Per-member permission overrides ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_member_permission (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  permission    TEXT NOT NULL,
  granted       BOOLEAN NOT NULL,
  PRIMARY KEY (production_id, open_id, permission)
);
