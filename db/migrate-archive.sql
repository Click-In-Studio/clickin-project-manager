-- Run against script_editor as postgres superuser
\c script_editor

ALTER TABLE production ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
