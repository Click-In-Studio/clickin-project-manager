-- Add version_id to production_event: each event can pin to a specific script version.
-- Idempotent: safe to run on an existing database.

ALTER TABLE production_event
  ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES version(id) ON DELETE SET NULL;
