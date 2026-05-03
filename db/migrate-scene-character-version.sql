-- Version-scoped scene and character snapshot tables.
-- Idempotent: safe to run on an existing database.

-- ── 1. scene_version ──────────────────────────────────────────────────────────
-- Stores the script-relevant fields for each scene per version.
-- Extended dramaturgy metadata (synopsis, action_line, …) stays in scene table.

CREATE TABLE IF NOT EXISTS scene_version (
  scene_id    TEXT NOT NULL REFERENCES scene(id),
  version_id  TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  num         TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  parent_id   TEXT REFERENCES scene(id) ON DELETE SET NULL,
  PRIMARY KEY (scene_id, version_id)
);

CREATE INDEX IF NOT EXISTS scene_version_version_idx ON scene_version(version_id, sort_order);

-- ── 2. character_version ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS character_version (
  character_id TEXT NOT NULL REFERENCES character(id),
  version_id   TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_aggregate BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (character_id, version_id)
);

CREATE INDEX IF NOT EXISTS character_version_version_idx ON character_version(version_id, sort_order);

-- ── 3. Seed scene_version from existing scene rows ────────────────────────────

INSERT INTO scene_version (scene_id, version_id, num, name, sort_order, parent_id)
SELECT s.id, v.id, s.num, s.name, s.sort_order, s.parent_id
FROM scene s
JOIN version v ON v.production_id = s.production_id
ON CONFLICT (scene_id, version_id) DO NOTHING;

-- ── 4. Seed character_version from existing character rows ────────────────────

INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate)
SELECT c.id, v.id, c.name, c.sort_order, c.is_aggregate
FROM character c
JOIN version v ON v.production_id = c.production_id
ON CONFLICT (character_id, version_id) DO NOTHING;
