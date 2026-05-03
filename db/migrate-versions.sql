-- Version control migration
-- Idempotent: safe to run on an existing database.

-- ── 1. version_status enum ────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE version_status AS ENUM ('editing', 'committed', 'frozen', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. version table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS version (
  id                TEXT PRIMARY KEY,
  production_id     TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name              TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  tags              TEXT[] NOT NULL DEFAULT '{}',
  parent_version_id TEXT REFERENCES version(id) ON DELETE SET NULL,
  status            version_status NOT NULL DEFAULT 'editing',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS version_production_idx ON version(production_id, created_at);

-- ── 3. Seed initial version for each existing production ──────────────────────
-- ID convention: <production_id>_v1 for the bootstrap version

INSERT INTO version (id, production_id, name, status)
SELECT id || '_v1', id, 'V1', 'editing'
FROM production
ON CONFLICT (id) DO NOTHING;

-- ── 4. script table: add block_id (logical identity) ─────────────────────────

ALTER TABLE script ADD COLUMN IF NOT EXISTS block_id TEXT;
UPDATE script SET block_id = id WHERE block_id IS NULL;
ALTER TABLE script ALTER COLUMN block_id SET NOT NULL;

-- ── 5. script_version relation table ─────────────────────────────────────────
-- Maps (snapshot_id, version_id) → (block_id, sort_key)
-- sort_key moves from script main table to here

CREATE TABLE IF NOT EXISTS script_version (
  snapshot_id TEXT NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  version_id  TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  block_id    TEXT NOT NULL,
  sort_key    TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, version_id)
);

CREATE INDEX IF NOT EXISTS script_version_version_idx ON script_version(version_id, sort_key);

-- ── 6. Populate script_version from existing script rows ─────────────────────

INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key)
SELECT s.id, s.production_id || '_v1', s.id, s.sort_key
FROM script s
ON CONFLICT (snapshot_id, version_id) DO NOTHING;

-- ── 7. Cue table: add cue_id (logical identity) and snapshot anchor columns ───

ALTER TABLE cue ADD COLUMN IF NOT EXISTS cue_id TEXT;
UPDATE cue SET cue_id = id WHERE cue_id IS NULL;

-- Add new snapshot-based anchor columns (nullable: null = gap before first block)
ALTER TABLE cue ADD COLUMN IF NOT EXISTS start_snapshot_id TEXT;
ALTER TABLE cue ADD COLUMN IF NOT EXISTS end_snapshot_id   TEXT;

-- Copy values from old block_id columns (snapshot_id = block_id for initial data)
UPDATE cue SET start_snapshot_id = start_block_id WHERE start_snapshot_id IS NULL;
UPDATE cue SET end_snapshot_id   = end_block_id   WHERE end_snapshot_id   IS NULL;

-- Drop old block_id columns
ALTER TABLE cue DROP COLUMN IF EXISTS start_block_id;
ALTER TABLE cue DROP COLUMN IF EXISTS end_block_id;

-- ── 8. cue_version relation table ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cue_version (
  revision_id TEXT NOT NULL REFERENCES cue(id) ON DELETE CASCADE,
  version_id  TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  cue_id      TEXT NOT NULL,
  PRIMARY KEY (revision_id, version_id)
);

CREATE INDEX IF NOT EXISTS cue_version_version_idx ON cue_version(version_id);

-- ── 9. Populate cue_version from existing cues ───────────────────────────────

INSERT INTO cue_version (revision_id, version_id, cue_id)
SELECT c.id, cl.production_id || '_v1', c.id
FROM cue c
JOIN cue_list cl ON cl.id = c.cue_list_id
ON CONFLICT (revision_id, version_id) DO NOTHING;
