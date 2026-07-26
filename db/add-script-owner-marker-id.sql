-- Historical values are backfilled lazily when a version is accessed.
ALTER TABLE script ADD COLUMN IF NOT EXISTS owner_marker_id TEXT;
