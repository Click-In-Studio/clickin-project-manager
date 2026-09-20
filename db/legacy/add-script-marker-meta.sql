ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'chapter_marker';
ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'scene_marker';
ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'rehearsal_marker';
ALTER TABLE script ADD COLUMN IF NOT EXISTS marker_meta JSONB NOT NULL DEFAULT '{}';
