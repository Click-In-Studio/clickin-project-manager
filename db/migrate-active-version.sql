-- Add active_version_id to production as an explicit FK to the current working version.
-- Eliminates the need for querying version table by status for fallback resolution.
ALTER TABLE production ADD COLUMN IF NOT EXISTS active_version_id TEXT REFERENCES version(id);

UPDATE production p
SET active_version_id = (
  SELECT id FROM version
  WHERE production_id = p.id AND status = 'editing'
  ORDER BY created_at DESC LIMIT 1
);

-- Strip data columns from scene — it is now a pure identity anchor (id, production_id).
-- All scene data lives in scene_version keyed by (scene_id, version_id).
ALTER TABLE scene
  DROP COLUMN IF EXISTS num,
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS sort_order,
  DROP COLUMN IF EXISTS parent_id,
  DROP COLUMN IF EXISTS synopsis,
  DROP COLUMN IF EXISTS action_line,
  DROP COLUMN IF EXISTS music,
  DROP COLUMN IF EXISTS stage_notes,
  DROP COLUMN IF EXISTS expected_duration;
