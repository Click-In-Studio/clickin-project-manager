ALTER TABLE version ADD COLUMN IF NOT EXISTS script_config JSONB NOT NULL DEFAULT '{}';

WITH first_chapter AS (
  SELECT DISTINCT ON (sv.version_id)
    sv.version_id,
    sv.block_id
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE s.type = 'chapter_marker'
  ORDER BY sv.version_id, sv.sort_key
)
UPDATE version v
SET script_config = COALESCE(v.script_config, '{}'::jsonb)
  || jsonb_build_object('openingChapterMarkerId', first_chapter.block_id)
FROM first_chapter
WHERE first_chapter.version_id = v.id
  AND NOT (COALESCE(v.script_config, '{}'::jsonb) ? 'openingChapterMarkerId');
