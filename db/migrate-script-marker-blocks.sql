-- Migration: convert legacy text-level scene/rehearsal ownership to marker blocks
--
-- Background:
--   Older script rows stored scene_id and rehearsal_mark directly on each text
--   block. The current editor model stores chapter/scene/rehearsal boundaries as
--   explicit marker blocks, while text blocks keep scene_id/rehearsal_mark NULL.
--
-- What this migration does:
--   1. For each version that has legacy-owned text blocks and no marker blocks,
--      rebuild that version's script block stream.
--   2. Insert chapter_marker / scene_marker / rehearsal_marker snapshots before
--      the relevant text blocks.
--   3. Copy only text snapshots that need scene_id/rehearsal_mark cleared,
--      preserving block ids, content, character associations, block tags,
--      comments, block_snapshot asset mounts, and cue anchors when the cue
--      revision is not shared with versions outside the migration set.
--   4. Replace script_version rows for migrated versions with the rebuilt stream.
--
ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'chapter_marker';
ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'scene_marker';
ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'rehearsal_marker';

-- Safe to re-run:
--   Versions that already contain marker blocks are skipped.
--   Versions without legacy-owned text blocks are skipped.

BEGIN;

ALTER TABLE script ADD COLUMN IF NOT EXISTS marker_meta JSONB NOT NULL DEFAULT '{}';

-- script_version must contain exactly one current snapshot for each logical
-- block in a version. Clean old duplicate rows before any marker derivation so
-- readers do not need ROW_NUMBER()/DISTINCT ON corruption masking.
WITH duplicate_candidates AS (
  SELECT
    sv.snapshot_id,
    sv.version_id,
    sv.block_id,
    ROW_NUMBER() OVER (
      PARTITION BY sv.version_id, sv.block_id
      ORDER BY
        CASE
          WHEN s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
           AND COALESCE(
             NULLIF(s.marker_meta->>'name', ''),
             NULLIF(s.marker_meta->>'number', ''),
             NULLIF(s.marker_meta->>'synopsis', ''),
             NULLIF(s.marker_meta->>'actionLine', ''),
             NULLIF(s.marker_meta->>'music', ''),
             NULLIF(s.marker_meta->>'stageNotes', ''),
             NULLIF(s.marker_meta->>'expectedDuration', '')
           ) IS NOT NULL THEN 0
          ELSE 1
        END,
        s.created_at DESC,
        sv.sort_key DESC,
        sv.snapshot_id DESC
    ) AS keep_rank
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
),
removed_duplicate_versions AS (
  DELETE FROM script_version sv
  USING duplicate_candidates dc
  WHERE sv.snapshot_id = dc.snapshot_id
    AND sv.version_id = dc.version_id
    AND dc.keep_rank > 1
  RETURNING sv.snapshot_id
),
deleted_orphan_snapshots AS (
  DELETE FROM script s
  WHERE s.id IN (SELECT snapshot_id FROM removed_duplicate_versions)
    AND NOT EXISTS (
      SELECT 1 FROM script_version sv
      WHERE sv.snapshot_id = s.id
    )
  RETURNING s.id
)
SELECT
  (SELECT COUNT(*) FROM removed_duplicate_versions) AS duplicate_script_versions_removed,
  (SELECT COUNT(*) FROM deleted_orphan_snapshots) AS orphan_snapshots_removed;

CREATE OR REPLACE FUNCTION pg_temp._marker_migration_base36(value numeric)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  alphabet CONSTANT TEXT := '0123456789abcdefghijklmnopqrstuvwxyz';
  n numeric := greatest(0, floor(value));
  digit integer;
  result TEXT := '';
BEGIN
  IF n = 0 THEN
    RETURN '0000000000';
  END IF;
  WHILE n > 0 LOOP
    digit := mod(n, 36);
    result := substr(alphabet, digit + 1, 1) || result;
    n := floor(n / 36);
  END LOOP;
  RETURN lpad(right(result, 10), 10, '0');
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp._marker_migration_alpha_label(index_value bigint)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  n bigint := index_value + 1;
  result TEXT := '';
  digit integer;
BEGIN
  WHILE n > 0 LOOP
    n := n - 1;
    digit := mod(n, 26);
    result := chr(65 + digit) || result;
    n := floor(n / 26);
  END LOOP;
  RETURN result;
END;
$$;

CREATE TEMP TABLE _marker_migration_versions AS
SELECT
  sv.version_id,
  v.production_id
FROM script_version sv
JOIN script s ON s.id = sv.snapshot_id
JOIN version v ON v.id = sv.version_id
GROUP BY sv.version_id, v.production_id
HAVING
  COUNT(*) FILTER (
    WHERE s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
  ) = 0
  AND COUNT(*) FILTER (
    WHERE s.type NOT IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
      AND (s.scene_id IS NOT NULL OR s.rehearsal_mark IS NOT NULL)
  ) > 0;

CREATE INDEX _marker_migration_versions_version_idx
  ON _marker_migration_versions(version_id);

-- Ensure the fixed initial chapter exists for every migrated version. Newer
-- editor loads add this lazily; the migration should be complete without that
-- client-side repair pass.
INSERT INTO scene (id, production_id)
SELECT DISTINCT
  '__fixed_initial_chapter_marker',
  production_id
FROM _marker_migration_versions
ON CONFLICT (id) DO NOTHING;

INSERT INTO scene_version (scene_id, version_id, num, name, sort_order, parent_id)
SELECT
  '__fixed_initial_chapter_marker',
  version_id,
  '',
  '开场',
  -1,
  NULL
FROM _marker_migration_versions
ON CONFLICT (scene_id, version_id) DO UPDATE
  SET name = CASE
    WHEN scene_version.name = '' THEN EXCLUDED.name
    ELSE scene_version.name
  END;

CREATE TEMP TABLE _marker_migration_ordered AS
WITH base AS (
  SELECT
    mv.version_id,
    mv.production_id,
    sv.snapshot_id AS old_snapshot_id,
    sv.block_id AS old_block_id,
    s.scene_id,
    s.rehearsal_mark,
    s.type::text AS old_type,
    s.content,
    s.stage_comment,
    s.force_show_character_name,
    scene.parent_id AS scene_parent_id,
    COALESCE(scene.parent_id, s.scene_id) AS effective_chapter_id,
    lag(s.scene_id) OVER version_order AS prev_scene_id,
    lag(s.rehearsal_mark) OVER version_order AS prev_rehearsal_mark,
    row_number() OVER version_order AS original_row_num
  FROM _marker_migration_versions mv
  JOIN script_version sv ON sv.version_id = mv.version_id
  JOIN script s ON s.id = sv.snapshot_id
  LEFT JOIN scene_version scene
    ON scene.version_id = mv.version_id
   AND scene.scene_id = s.scene_id
  WINDOW version_order AS (PARTITION BY mv.version_id ORDER BY sv.sort_key, sv.block_id, sv.snapshot_id)
),
previous_chapter AS (
  SELECT
    base.*,
    max(CASE WHEN effective_chapter_id IS NOT NULL THEN original_row_num END) OVER (
      PARTITION BY version_id
      ORDER BY original_row_num
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS previous_chapter_row_num
  FROM base
)
SELECT
  previous_chapter.version_id,
  previous_chapter.production_id,
  previous_chapter.old_snapshot_id,
  previous_chapter.old_block_id,
  previous_chapter.scene_id,
  previous_chapter.rehearsal_mark,
  previous_chapter.old_type,
  previous_chapter.content,
  previous_chapter.stage_comment,
  previous_chapter.force_show_character_name,
  previous_chapter.scene_parent_id,
  previous_chapter.prev_scene_id,
  previous_chapter.prev_rehearsal_mark,
  COALESCE(chapter_before.effective_chapter_id, '__fixed_initial_chapter_marker') AS previous_chapter_id,
  previous_chapter.original_row_num
FROM previous_chapter
LEFT JOIN base chapter_before
  ON chapter_before.version_id = previous_chapter.version_id
 AND chapter_before.original_row_num = previous_chapter.previous_chapter_row_num;

CREATE TEMP TABLE _marker_migration_items (
  version_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  old_snapshot_id TEXT,
  new_snapshot_id TEXT NOT NULL,
  new_block_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  marker_type block_type,
  marker_scene_id TEXT,
  marker_rehearsal_mark TEXT,
  old_type block_type,
  content TEXT,
  stage_comment TEXT,
  force_show_character_name BOOLEAN NOT NULL DEFAULT FALSE,
  original_row_num BIGINT NOT NULL,
  item_order INTEGER NOT NULL
);

-- Keep the invariant expected by ScriptEditor: every migrated version starts
-- with the fixed initial chapter marker.
INSERT INTO _marker_migration_items (
  version_id, production_id, new_snapshot_id, new_block_id, item_kind,
  marker_type, marker_scene_id, original_row_num, item_order
)
SELECT
  mv.version_id,
  mv.production_id,
  'sn_mig_' || substr(md5(mv.version_id || ':fixed_initial_chapter'), 1, 24),
  '__fixed_initial_chapter_marker',
  'marker',
  'chapter_marker'::block_type,
  '__fixed_initial_chapter_marker',
  0,
  0
FROM _marker_migration_versions mv;

-- Insert chapter markers when entering a chapter scene or when entering a
-- sub-scene whose parent chapter differs from the current chapter.
INSERT INTO _marker_migration_items (
  version_id, production_id, old_snapshot_id,
  new_snapshot_id, new_block_id, item_kind, marker_type, marker_scene_id,
  original_row_num, item_order
)
SELECT
  version_id,
  production_id,
  old_snapshot_id,
  'sn_mig_' || substr(md5(version_id || ':' || old_snapshot_id || ':chapter:' || chapter_id), 1, 24),
  'mig_marker_' || substr(md5(version_id || ':' || old_snapshot_id || ':chapter:' || chapter_id), 1, 24),
  'marker',
  'chapter_marker'::block_type,
  chapter_id,
  original_row_num,
  1
FROM (
  SELECT
    *,
    COALESCE(scene_parent_id, scene_id) AS chapter_id
  FROM _marker_migration_ordered
  WHERE scene_id IS NOT NULL
) owned
WHERE scene_id IS DISTINCT FROM prev_scene_id
  AND COALESCE(scene_parent_id, scene_id) IS DISTINCT FROM previous_chapter_id
  AND COALESCE(scene_parent_id, scene_id) IS DISTINCT FROM '__fixed_initial_chapter_marker'
  AND COALESCE(scene_parent_id, scene_id) IS DISTINCT FROM '__fixed_initial_chapter_scene';

-- Insert scene markers for sub-scenes.
INSERT INTO _marker_migration_items (
  version_id, production_id, old_snapshot_id,
  new_snapshot_id, new_block_id, item_kind, marker_type, marker_scene_id,
  original_row_num, item_order
)
SELECT
  version_id,
  production_id,
  old_snapshot_id,
  'sn_mig_' || substr(md5(version_id || ':' || old_snapshot_id || ':scene:' || scene_id), 1, 24),
  'mig_marker_' || substr(md5(version_id || ':' || old_snapshot_id || ':scene:' || scene_id), 1, 24),
  'marker',
  'scene_marker'::block_type,
  scene_id,
  original_row_num,
  2
FROM _marker_migration_ordered
WHERE scene_id IS NOT NULL
  AND scene_parent_id IS NOT NULL
  AND scene_id IS DISTINCT FROM prev_scene_id;

-- Insert rehearsal markers. Labels are generated per chapter/scene segment using
-- the same A, B, ... convention as the application code.
WITH rehearsal_boundaries AS (
  SELECT
    *,
    COALESCE(scene_id, '__no_scene__') AS rehearsal_scope
  FROM _marker_migration_ordered
  WHERE rehearsal_mark IS NOT NULL
    AND (
      rehearsal_mark IS DISTINCT FROM prev_rehearsal_mark
      OR scene_id IS DISTINCT FROM prev_scene_id
    )
),
numbered AS (
  SELECT
    *,
    row_number() OVER (
      PARTITION BY version_id, rehearsal_scope
      ORDER BY original_row_num
    ) - 1 AS rehearsal_index
  FROM rehearsal_boundaries
)
INSERT INTO _marker_migration_items (
  version_id, production_id, old_snapshot_id,
  new_snapshot_id, new_block_id, item_kind, marker_type, marker_rehearsal_mark,
  original_row_num, item_order
)
SELECT
  version_id,
  production_id,
  old_snapshot_id,
  'sn_mig_' || substr(md5(version_id || ':' || old_snapshot_id || ':rehearsal:' || rehearsal_mark), 1, 24),
  'mig_marker_' || substr(md5(version_id || ':' || old_snapshot_id || ':rehearsal:' || rehearsal_mark), 1, 24),
  'marker',
  'rehearsal_marker'::block_type,
  pg_temp._marker_migration_alpha_label(rehearsal_index),
  original_row_num,
  3
FROM numbered;

-- Copy each original text snapshot into a clean marker-model text snapshot.
INSERT INTO _marker_migration_items (
  version_id, production_id, old_snapshot_id,
  new_snapshot_id, new_block_id, item_kind, old_type, content, stage_comment,
  force_show_character_name, original_row_num, item_order
)
SELECT
  version_id,
  production_id,
  old_snapshot_id,
  CASE
    WHEN scene_id IS NULL AND rehearsal_mark IS NULL THEN old_snapshot_id
    ELSE 'sn_mig_' || substr(md5(old_snapshot_id || ':text'), 1, 24)
  END,
  old_block_id,
  'text',
  old_type::block_type,
  content,
  stage_comment,
  force_show_character_name,
  original_row_num,
  4
FROM _marker_migration_ordered;

CREATE TEMP TABLE _marker_migration_ranked AS
SELECT
  *,
  row_number() OVER (
    PARTITION BY version_id
    ORDER BY original_row_num, item_order, new_block_id
  ) AS new_row_num,
  count(*) OVER (PARTITION BY version_id) AS version_item_count
FROM _marker_migration_items;

CREATE TEMP TABLE _marker_migration_final AS
SELECT
  *,
  pg_temp._marker_migration_base36(
    3656158440062976::numeric * new_row_num / (version_item_count + 1)
  ) AS new_sort_key
FROM _marker_migration_ranked;

CREATE INDEX _marker_migration_final_old_snapshot_idx
  ON _marker_migration_final(old_snapshot_id)
  WHERE item_kind = 'text';

-- Insert marker and cleaned text snapshots.
INSERT INTO script (
  id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type,
  content, stage_comment, marker_meta, force_show_character_name
)
SELECT
  f.new_snapshot_id,
  f.new_block_id,
  f.production_id,
  f.new_sort_key,
  CASE WHEN item_kind = 'marker' THEN marker_scene_id ELSE NULL END,
  CASE WHEN item_kind = 'marker' THEN marker_rehearsal_mark ELSE NULL END,
  CASE WHEN item_kind = 'marker' THEN marker_type ELSE old_type END,
  COALESCE(f.content, ''),
  CASE WHEN item_kind = 'text' THEN stage_comment ELSE NULL END,
  CASE
    WHEN f.item_kind = 'marker' AND f.marker_type IN ('chapter_marker', 'scene_marker')
      THEN jsonb_strip_nulls(jsonb_build_object(
        'number', NULLIF(scene_meta.num, ''),
        'name', COALESCE(scene_meta.name, ''),
        'parentMarkerId', scene_meta.parent_id,
        'synopsis', NULLIF(scene_meta.synopsis, ''),
        'actionLine', NULLIF(scene_meta.action_line, ''),
        'music', NULLIF(scene_meta.music, ''),
        'stageNotes', NULLIF(scene_meta.stage_notes, ''),
        'expectedDuration', NULLIF(scene_meta.expected_duration, '')
      ))
    ELSE '{}'::jsonb
  END,
  CASE WHEN item_kind = 'text' THEN force_show_character_name ELSE FALSE END
FROM _marker_migration_final f
LEFT JOIN scene_version scene_meta
  ON scene_meta.version_id = f.version_id
 AND scene_meta.scene_id = f.marker_scene_id
ON CONFLICT (id) DO NOTHING;

-- Move cue anchors from legacy-owned snapshots to the clean text snapshots now
-- referenced by migrated script_version rows. The clean snapshot id is stable
-- per original snapshot so shared cue revisions can keep one anchor. If a cue
-- revision is also referenced by a version outside this migration set, leave it
-- untouched rather than changing another version's anchor.
UPDATE cue c
SET start_snapshot_id = f.new_snapshot_id
FROM _marker_migration_final f
WHERE f.item_kind = 'text'
  AND f.new_snapshot_id <> f.old_snapshot_id
  AND c.start_snapshot_id = f.old_snapshot_id
  AND EXISTS (
    SELECT 1
    FROM cue_version cv
    WHERE cv.revision_id = c.id
      AND cv.version_id = f.version_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cue_version cv
    LEFT JOIN _marker_migration_versions mv ON mv.version_id = cv.version_id
    WHERE cv.revision_id = c.id
      AND mv.version_id IS NULL
  );

UPDATE cue c
SET end_snapshot_id = f.new_snapshot_id
FROM _marker_migration_final f
WHERE f.item_kind = 'text'
  AND f.new_snapshot_id <> f.old_snapshot_id
  AND c.end_snapshot_id = f.old_snapshot_id
  AND EXISTS (
    SELECT 1
    FROM cue_version cv
    WHERE cv.revision_id = c.id
      AND cv.version_id = f.version_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cue_version cv
    LEFT JOIN _marker_migration_versions mv ON mv.version_id = cv.version_id
    WHERE cv.revision_id = c.id
      AND mv.version_id IS NULL
  );

-- Preserve character assignments for copied text snapshots.
INSERT INTO script_character (script_id, character_id, position, annotation)
SELECT
  f.new_snapshot_id,
  sc.character_id,
  sc.position,
  sc.annotation
FROM _marker_migration_final f
JOIN script_character sc ON sc.script_id = f.old_snapshot_id
WHERE f.item_kind = 'text'
  AND f.new_snapshot_id <> f.old_snapshot_id
ON CONFLICT (script_id, character_id) DO NOTHING;

-- Preserve block snapshot asset mounts for copied text snapshots.
INSERT INTO asset_mount (
  id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
  folder_path, mount_mode, version_resolved, created_by
)
SELECT
  'am_' || substr(md5(am.id || ':' || f.new_snapshot_id), 1, 16),
  am.asset_id,
  am.production_id,
  am.mount_type,
  f.new_snapshot_id,
  am.mount_aux_id,
  am.folder_path,
  am.mount_mode,
  am.version_resolved,
  am.created_by
FROM _marker_migration_final f
JOIN asset_mount am
  ON am.mount_type = 'block_snapshot'
 AND am.mount_id = f.old_snapshot_id
WHERE f.item_kind = 'text'
  AND f.new_snapshot_id <> f.old_snapshot_id
ON CONFLICT (id) DO NOTHING;

-- Remap migrated versions to the rebuilt stream.
DELETE FROM script_version sv
USING _marker_migration_versions mv
WHERE sv.version_id = mv.version_id;

INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key)
SELECT
  new_snapshot_id,
  version_id,
  new_block_id,
  new_sort_key
FROM _marker_migration_final
ORDER BY version_id, new_row_num;

-- Keep old snapshots even when they become unreferenced by script_version.
-- Cue anchors store snapshot ids without FKs and still rely on joining back to
-- script rows to recover logical block ids, so deleting old rows here would make
-- historical cue anchors harder to resolve.

-- If old dramaturgy rows still exist without a corresponding marker block,
-- create the missing markers first instead of dropping the dramaturgy data.
-- The old scene_version.scene_id becomes the marker block_id, so compatibility
-- references can continue to point at the canonical marker identity.
WITH marker_rows AS (
  SELECT
    sv.version_id,
    sv.block_id AS marker_block_id,
    s.id AS marker_snapshot_id,
    s.scene_id AS legacy_scene_id,
    s.type::text AS marker_type,
    sv.sort_key
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE s.type IN ('chapter_marker', 'scene_marker')
),
repair_scene_versions AS (
  SELECT
    sv.version_id,
    v.production_id,
    sv.scene_id,
    sv.num,
    sv.name,
    sv.sort_order,
    COALESCE(sv.parent_id, parent_by_num.scene_id) AS parent_id,
    sv.synopsis,
    sv.action_line,
    sv.music,
    sv.stage_notes,
    sv.expected_duration,
    CASE
      WHEN btrim(sv.num) ~ '^[0-9]+\\s*-\\s*[0-9]+' THEN 'scene_marker'
      WHEN btrim(sv.num) ~ '^[0-9]+$' THEN 'chapter_marker'
      WHEN COALESCE(sv.parent_id, parent_by_num.scene_id) IS NOT NULL THEN 'scene_marker'
      ELSE 'chapter_marker'
    END AS marker_type,
    'sn_orphan_marker_' || substr(md5(sv.version_id || ':' || sv.scene_id), 1, 24) AS generated_snapshot_id,
    MAX(sv.sort_order) OVER (PARTITION BY sv.version_id) AS version_max_sort_order,
    ROW_NUMBER() OVER (PARTITION BY sv.version_id ORDER BY sv.sort_order, sv.scene_id) AS version_row_num
  FROM scene_version sv
  JOIN version v ON v.id = sv.version_id
  LEFT JOIN scene_version parent_by_num
    ON parent_by_num.version_id = sv.version_id
   AND parent_by_num.num = split_part(regexp_replace(btrim(sv.num), '\\s+', '', 'g'), '-', 1)
   AND parent_by_num.scene_id <> sv.scene_id
  LEFT JOIN marker_rows existing_marker
    ON existing_marker.version_id = sv.version_id
   AND sv.scene_id IN (existing_marker.marker_block_id, existing_marker.legacy_scene_id)
  WHERE (
      existing_marker.marker_block_id IS NULL
      OR existing_marker.marker_snapshot_id = 'sn_orphan_marker_' || substr(md5(sv.version_id || ':' || sv.scene_id), 1, 24)
    )
    AND COALESCE(
      NULLIF(sv.num, ''),
      NULLIF(sv.name, ''),
      NULLIF(sv.synopsis, ''),
      NULLIF(sv.action_line, ''),
      NULLIF(sv.music, ''),
      NULLIF(sv.stage_notes, ''),
      NULLIF(sv.expected_duration, '')
    ) IS NOT NULL
),
repair_with_chapter_key AS (
  SELECT
    *,
    pg_temp._marker_migration_base36(
      3656158440062976::numeric * (sort_order + 1) / (GREATEST(version_max_sort_order + 2, 2))
    ) || 'c' || lpad(version_row_num::text, 4, '0') AS chapter_sort_key
  FROM repair_scene_versions
),
repair_positioned AS (
  SELECT
    r.*,
    COALESCE(parent_marker.marker_block_id, r.parent_id) AS parent_marker_id,
    CASE
      WHEN r.marker_type = 'chapter_marker' THEN r.chapter_sort_key
      ELSE COALESCE(parent_repair.chapter_sort_key, parent_marker.sort_key, r.chapter_sort_key)
        || 'o'
        || lpad(ROW_NUMBER() OVER (
          PARTITION BY r.version_id, r.parent_id
          ORDER BY r.sort_order, r.scene_id
        )::text, 4, '0')
    END AS desired_sort_key
  FROM repair_with_chapter_key r
  LEFT JOIN marker_rows parent_marker
    ON parent_marker.version_id = r.version_id
   AND r.parent_id IN (parent_marker.marker_block_id, parent_marker.legacy_scene_id)
  LEFT JOIN repair_with_chapter_key parent_repair
    ON parent_repair.version_id = r.version_id
   AND parent_repair.scene_id = r.parent_id
   AND parent_repair.marker_type = 'chapter_marker'
),
inserted_snapshots AS (
  INSERT INTO script (
    id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type,
    content, stage_comment, marker_meta, force_show_character_name
  )
  SELECT
    generated_snapshot_id,
    scene_id,
    production_id,
    desired_sort_key,
    scene_id,
    NULL,
    marker_type::block_type,
    '',
    NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'number', NULLIF(num, ''),
      'name', COALESCE(name, ''),
      'parentMarkerId', parent_marker_id,
      'synopsis', synopsis,
      'actionLine', action_line,
      'music', music,
      'stageNotes', stage_notes,
      'expectedDuration', expected_duration
    )),
    FALSE
  FROM repair_positioned
  ON CONFLICT (id) DO UPDATE
    SET sort_key = EXCLUDED.sort_key,
        scene_id = EXCLUDED.scene_id,
        type = EXCLUDED.type,
        marker_meta = script.marker_meta || EXCLUDED.marker_meta
  RETURNING id
),
inserted_versions AS (
  INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key)
  SELECT
    generated_snapshot_id,
    version_id,
    scene_id,
    desired_sort_key
  FROM repair_positioned
  ON CONFLICT (snapshot_id, version_id) DO UPDATE
    SET block_id = EXCLUDED.block_id,
        sort_key = EXCLUDED.sort_key
  RETURNING snapshot_id
)
SELECT
  (SELECT COUNT(*) FROM inserted_snapshots) AS missing_marker_snapshots_upserted,
  (SELECT COUNT(*) FROM inserted_versions) AS missing_marker_version_rows_inserted;

-- Older broken marker migrations could leave multiple script_version rows for
-- the same logical block in one version. Keep the canonical snapshot for each
-- block so readers, patching, and scene cache sync all operate on one row.
WITH ranked_version_rows AS (
  SELECT
    sv.snapshot_id,
    sv.version_id,
    sv.block_id,
    ROW_NUMBER() OVER (
      PARTITION BY sv.version_id, sv.block_id
      ORDER BY
        CASE
          WHEN s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker') THEN
            CASE WHEN COALESCE(
              NULLIF(s.marker_meta->>'name', ''),
              NULLIF(s.marker_meta->>'number', ''),
              NULLIF(s.marker_meta->>'synopsis', ''),
              NULLIF(s.marker_meta->>'actionLine', ''),
              NULLIF(s.marker_meta->>'music', ''),
              NULLIF(s.marker_meta->>'stageNotes', ''),
              NULLIF(s.marker_meta->>'expectedDuration', '')
            ) IS NOT NULL THEN 0 ELSE 1 END
          ELSE CASE WHEN sv.snapshot_id = sv.block_id THEN 0 ELSE 1 END
        END,
        sv.sort_key DESC,
        sv.snapshot_id DESC
    ) AS rn
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
),
deleted_duplicate_rows AS (
  DELETE FROM script_version sv
  USING ranked_version_rows ranked
  WHERE sv.snapshot_id = ranked.snapshot_id
    AND sv.version_id = ranked.version_id
    AND ranked.rn > 1
  RETURNING sv.snapshot_id
)
SELECT COUNT(*) AS duplicate_script_version_rows_removed FROM deleted_duplicate_rows;

-- Remove empty marker placeholders generated by earlier broken repairs. These
-- rows have no dramaturgy detail to preserve and would surface as blank
-- chapters/scenes in marker-backed readers.
WITH empty_generated_markers AS (
  SELECT
    sv.snapshot_id,
    sv.version_id,
    sv.block_id
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  LEFT JOIN scene_version source_sv
    ON source_sv.version_id = sv.version_id
   AND source_sv.scene_id = sv.block_id
  WHERE sv.snapshot_id LIKE 'sn_orphan_marker_%'
    AND s.type IN ('chapter_marker', 'scene_marker')
    AND COALESCE(
      NULLIF(source_sv.name, ''),
      NULLIF(source_sv.synopsis, ''),
      NULLIF(source_sv.action_line, ''),
      NULLIF(source_sv.music, ''),
      NULLIF(source_sv.stage_notes, ''),
      NULLIF(source_sv.expected_duration, ''),
      NULLIF(s.marker_meta->>'name', ''),
      NULLIF(s.marker_meta->>'synopsis', ''),
      NULLIF(s.marker_meta->>'actionLine', ''),
      NULLIF(s.marker_meta->>'music', ''),
      NULLIF(s.marker_meta->>'stageNotes', ''),
      NULLIF(s.marker_meta->>'expectedDuration', '')
    ) IS NULL
),
deleted_version_rows AS (
  DELETE FROM script_version sv
  USING empty_generated_markers egm
  WHERE sv.snapshot_id = egm.snapshot_id
    AND sv.version_id = egm.version_id
  RETURNING sv.snapshot_id
),
deleted_snapshots AS (
  DELETE FROM script s
  USING deleted_version_rows dvr
  WHERE s.id = dvr.snapshot_id
    AND NOT EXISTS (
      SELECT 1 FROM script_version remaining
      WHERE remaining.snapshot_id = s.id
    )
  RETURNING s.id
)
SELECT
  (SELECT COUNT(*) FROM deleted_version_rows) AS empty_generated_marker_version_rows_removed,
  (SELECT COUNT(*) FROM deleted_snapshots) AS empty_generated_marker_snapshots_removed;

-- Remove blank non-fixed chapter/scene markers generated from malformed legacy
-- rows. A real chapter can have an empty name, but it must at least have a
-- number or detail metadata; otherwise it creates a phantom dramaturgy row.
WITH blank_markers AS (
  SELECT
    sv.snapshot_id,
    sv.version_id,
    sv.block_id
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE s.type IN ('chapter_marker', 'scene_marker')
    AND sv.block_id <> '__fixed_initial_chapter_marker'
    AND COALESCE(
      NULLIF(s.marker_meta->>'number', ''),
      NULLIF(s.marker_meta->>'name', ''),
      NULLIF(s.marker_meta->>'synopsis', ''),
      NULLIF(s.marker_meta->>'actionLine', ''),
      NULLIF(s.marker_meta->>'music', ''),
      NULLIF(s.marker_meta->>'stageNotes', ''),
      NULLIF(s.marker_meta->>'expectedDuration', '')
    ) IS NULL
),
deleted_blank_marker_versions AS (
  DELETE FROM script_version sv
  USING blank_markers bm
  WHERE sv.snapshot_id = bm.snapshot_id
    AND sv.version_id = bm.version_id
  RETURNING sv.snapshot_id
),
deleted_blank_marker_snapshots AS (
  DELETE FROM script s
  USING deleted_blank_marker_versions dbmv
  WHERE s.id = dbmv.snapshot_id
    AND NOT EXISTS (
      SELECT 1 FROM script_version remaining
      WHERE remaining.snapshot_id = s.id
    )
  RETURNING s.id
)
SELECT
  (SELECT COUNT(*) FROM deleted_blank_marker_versions) AS blank_marker_version_rows_removed,
  (SELECT COUNT(*) FROM deleted_blank_marker_snapshots) AS blank_marker_snapshots_removed;

-- Some early joint imports stored scene-like dramaturgy rows with parent_id NULL,
-- then created marker snapshots whose legacy scene_id points at those rich rows.
-- A parent_id-only migration treats every one of those marker snapshots as a
-- chapter. Repair those versions by converting the rich legacy-backed markers
-- back to scene markers before deriving dramaturgy from marker order.
WITH marker_rows AS (
  SELECT
    sv.version_id,
    sv.block_id AS marker_block_id,
    s.id AS marker_snapshot_id,
    s.scene_id AS legacy_scene_id,
    s.type::text AS marker_type,
    s.marker_meta,
    sv.sort_key
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE s.type IN ('chapter_marker', 'scene_marker')
),
version_marker_counts AS (
  SELECT
    version_id,
    COUNT(*) FILTER (WHERE marker_type = 'chapter_marker') AS chapter_count,
    COUNT(*) FILTER (WHERE marker_type = 'scene_marker') AS scene_count
  FROM marker_rows
  GROUP BY version_id
),
fixed_chapters AS (
  SELECT DISTINCT ON (version_id)
    version_id,
    marker_block_id
  FROM marker_rows
  WHERE marker_block_id = '__fixed_initial_chapter_marker'
    AND marker_type = 'chapter_marker'
  ORDER BY version_id, sort_key
),
legacy_scene_markers AS (
  SELECT
    mr.marker_snapshot_id,
    COALESCE(parent_marker.marker_block_id, parent_by_num_marker.marker_block_id, parent_by_marker_meta.marker_block_id, fc.marker_block_id) AS parent_marker_id,
    COALESCE(source_sv.num, mr.marker_meta->>'number') AS num,
    COALESCE(source_sv.name, mr.marker_meta->>'name') AS name,
    COALESCE(source_sv.synopsis, mr.marker_meta->>'synopsis') AS synopsis,
    COALESCE(source_sv.action_line, mr.marker_meta->>'actionLine') AS action_line,
    COALESCE(source_sv.music, mr.marker_meta->>'music') AS music,
    COALESCE(source_sv.stage_notes, mr.marker_meta->>'stageNotes') AS stage_notes,
    COALESCE(source_sv.expected_duration, mr.marker_meta->>'expectedDuration') AS expected_duration
  FROM marker_rows mr
  JOIN version_marker_counts counts ON counts.version_id = mr.version_id
  LEFT JOIN scene_version source_sv
    ON source_sv.version_id = mr.version_id
   AND source_sv.scene_id IN (mr.legacy_scene_id, mr.marker_block_id)
  LEFT JOIN fixed_chapters fc ON fc.version_id = mr.version_id
  LEFT JOIN marker_rows parent_marker
    ON parent_marker.version_id = mr.version_id
   AND parent_marker.marker_block_id = source_sv.parent_id
  LEFT JOIN scene_version parent_by_num
    ON parent_by_num.version_id = source_sv.version_id
   AND parent_by_num.num = split_part(regexp_replace(btrim(COALESCE(source_sv.num, mr.marker_meta->>'number', '')), '\\s+', '', 'g'), '-', 1)
   AND parent_by_num.scene_id <> source_sv.scene_id
  LEFT JOIN marker_rows parent_by_num_marker
    ON parent_by_num_marker.version_id = mr.version_id
   AND parent_by_num_marker.marker_block_id = parent_by_num.scene_id
  LEFT JOIN marker_rows parent_by_marker_meta
    ON parent_by_marker_meta.version_id = mr.version_id
   AND parent_by_marker_meta.marker_block_id <> mr.marker_block_id
   AND parent_by_marker_meta.marker_type = 'chapter_marker'
   AND parent_by_marker_meta.marker_meta->>'number' = split_part(regexp_replace(btrim(COALESCE(source_sv.num, mr.marker_meta->>'number', '')), '\\s+', '', 'g'), '-', 1)
  WHERE counts.chapter_count > 1
    AND mr.marker_type = 'chapter_marker'
    AND mr.marker_block_id <> '__fixed_initial_chapter_marker'
    AND btrim(COALESCE(source_sv.num, mr.marker_meta->>'number', '')) ~ '^[0-9]+\\s*-\\s*[0-9]+'
    AND COALESCE(
      NULLIF(source_sv.num, ''),
      NULLIF(source_sv.name, ''),
      NULLIF(source_sv.synopsis, ''),
      NULLIF(source_sv.action_line, ''),
      NULLIF(source_sv.music, ''),
      NULLIF(source_sv.stage_notes, ''),
      NULLIF(source_sv.expected_duration, ''),
      NULLIF(mr.marker_meta->>'number', ''),
      NULLIF(mr.marker_meta->>'name', ''),
      NULLIF(mr.marker_meta->>'synopsis', ''),
      NULLIF(mr.marker_meta->>'actionLine', ''),
      NULLIF(mr.marker_meta->>'music', ''),
      NULLIF(mr.marker_meta->>'stageNotes', ''),
      NULLIF(mr.marker_meta->>'expectedDuration', '')
    ) IS NOT NULL
),
converted_markers AS (
  UPDATE script s
  SET type = 'scene_marker'::block_type,
      marker_meta = COALESCE(s.marker_meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'number', COALESCE(NULLIF(legacy_scene_markers.num, ''), s.marker_meta->>'number'),
        'name', COALESCE(NULLIF(legacy_scene_markers.name, ''), s.marker_meta->>'name', ''),
        'parentMarkerId', legacy_scene_markers.parent_marker_id,
        'synopsis', COALESCE(NULLIF(legacy_scene_markers.synopsis, ''), s.marker_meta->>'synopsis'),
        'actionLine', COALESCE(NULLIF(legacy_scene_markers.action_line, ''), s.marker_meta->>'actionLine'),
        'music', COALESCE(NULLIF(legacy_scene_markers.music, ''), s.marker_meta->>'music'),
        'stageNotes', COALESCE(NULLIF(legacy_scene_markers.stage_notes, ''), s.marker_meta->>'stageNotes'),
        'expectedDuration', COALESCE(NULLIF(legacy_scene_markers.expected_duration, ''), s.marker_meta->>'expectedDuration')
      ))
  FROM legacy_scene_markers
  WHERE s.id = legacy_scene_markers.marker_snapshot_id
  RETURNING s.id
)
SELECT COUNT(*) AS legacy_scene_markers_converted FROM converted_markers;

-- Marker blocks are the canonical chapter/scene structure. Copy versioned
-- dramaturgy metadata onto the marker snapshot itself before any reader starts
-- deriving dramaturgy from markers. The marker block_id is now the
-- chapter/scene identity; old scene_id remains only as a migration map.
WITH marker_rows AS (
  SELECT
    sv.version_id,
    sv.block_id AS marker_block_id,
    s.id AS marker_snapshot_id,
    s.scene_id AS legacy_scene_id,
    s.marker_meta,
    s.type::text AS type,
    sv.sort_key,
    sv.snapshot_id
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE s.type IN ('chapter_marker', 'scene_marker')
    AND s.scene_id IS NOT NULL
),
unique_marker_rows AS (
  SELECT
    version_id,
    marker_block_id,
    marker_snapshot_id,
    legacy_scene_id,
    marker_meta,
    type,
    sort_key,
    COUNT(*) FILTER (WHERE type = 'chapter_marker') OVER (
      PARTITION BY version_id ORDER BY sort_key
    ) AS chapter_seq
  FROM (
    SELECT DISTINCT ON (version_id, marker_block_id)
      version_id,
      marker_block_id,
      marker_snapshot_id,
      legacy_scene_id,
      marker_meta,
      type,
      sort_key,
      snapshot_id
    FROM marker_rows
    ORDER BY
      version_id,
      marker_block_id,
      CASE WHEN COALESCE(
        NULLIF(marker_meta->>'name', ''),
        NULLIF(marker_meta->>'number', ''),
        NULLIF(marker_meta->>'synopsis', ''),
        NULLIF(marker_meta->>'actionLine', ''),
        NULLIF(marker_meta->>'music', ''),
        NULLIF(marker_meta->>'stageNotes', ''),
        NULLIF(marker_meta->>'expectedDuration', '')
      ) IS NOT NULL THEN 0 ELSE 1 END,
      sort_key DESC,
      snapshot_id DESC
  ) unique_rows
),
marker_scenes AS (
  SELECT
    mr.version_id,
    mr.marker_block_id,
    mr.marker_snapshot_id,
    mr.legacy_scene_id,
    ROW_NUMBER() OVER (PARTITION BY mr.version_id ORDER BY mr.sort_key) - 1 AS sort_order,
    CASE
      WHEN mr.type = 'chapter_marker' THEN NULL
      ELSE (
        SELECT chapter.marker_block_id
        FROM unique_marker_rows chapter
        WHERE chapter.version_id = mr.version_id
          AND chapter.type = 'chapter_marker'
          AND chapter.chapter_seq = mr.chapter_seq
        ORDER BY chapter.sort_key DESC
        LIMIT 1
      )
    END AS parent_id
  FROM unique_marker_rows mr
),
metadata_source AS (
  SELECT DISTINCT ON (ms.marker_snapshot_id)
    ms.marker_snapshot_id,
    ms.parent_id,
    candidate.num,
    candidate.name,
    candidate.synopsis,
    candidate.action_line,
    candidate.music,
    candidate.stage_notes,
    candidate.expected_duration
  FROM marker_scenes ms
  LEFT JOIN LATERAL (
    SELECT
      sv.num,
      sv.name,
      sv.synopsis,
      sv.action_line,
      sv.music,
      sv.stage_notes,
      sv.expected_duration,
      CASE
        WHEN sv.scene_id = ms.legacy_scene_id THEN 0
        WHEN sv.scene_id = ms.marker_block_id THEN 1
        ELSE 2
      END AS match_rank,
      CASE
        WHEN COALESCE(
          NULLIF(sv.name, ''),
          NULLIF(sv.synopsis, ''),
          NULLIF(sv.action_line, ''),
          NULLIF(sv.music, ''),
          NULLIF(sv.stage_notes, ''),
          NULLIF(sv.expected_duration, '')
        ) IS NULL THEN 1
        ELSE 0
      END AS empty_rank
    FROM scene_version sv
    WHERE sv.version_id = ms.version_id
      AND sv.scene_id IN (ms.legacy_scene_id, ms.marker_block_id)
    ORDER BY empty_rank, match_rank
    LIMIT 1
  ) candidate ON TRUE
  ORDER BY
    ms.marker_snapshot_id,
    candidate.empty_rank,
    candidate.match_rank
),
updated_markers AS (
  UPDATE script s
  SET marker_meta = COALESCE(s.marker_meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'number', COALESCE(NULLIF(metadata_source.num, ''), s.marker_meta->>'number'),
    'name', COALESCE(NULLIF(metadata_source.name, ''), s.marker_meta->>'name', ''),
    'parentMarkerId', metadata_source.parent_id,
    'synopsis', COALESCE(NULLIF(metadata_source.synopsis, ''), s.marker_meta->>'synopsis'),
    'actionLine', COALESCE(NULLIF(metadata_source.action_line, ''), s.marker_meta->>'actionLine'),
    'music', COALESCE(NULLIF(metadata_source.music, ''), s.marker_meta->>'music'),
    'stageNotes', COALESCE(NULLIF(metadata_source.stage_notes, ''), s.marker_meta->>'stageNotes'),
    'expectedDuration', COALESCE(NULLIF(metadata_source.expected_duration, ''), s.marker_meta->>'expectedDuration')
  ))
  FROM metadata_source
  WHERE s.id = metadata_source.marker_snapshot_id
  RETURNING s.id
)
SELECT COUNT(*) AS marker_meta_backfilled FROM updated_markers;

-- Keep scene_version only as a compatibility cache keyed by marker block_id.
-- Older scene_id rows are no longer canonical once their data has been copied
-- to marker_meta; removing them prevents old readers from seeing duplicates.
WITH marker_rows AS (
  SELECT
    sv.version_id,
    sv.block_id AS marker_block_id,
    s.id AS marker_snapshot_id,
    s.scene_id AS legacy_scene_id,
    s.marker_meta,
    s.type::text AS marker_type,
    sv.sort_key,
    sv.snapshot_id
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE s.type IN ('chapter_marker', 'scene_marker')
),
unique_marker_rows AS (
  SELECT
    version_id,
    marker_block_id,
    marker_snapshot_id,
    legacy_scene_id,
    marker_meta,
    marker_type,
    sort_key,
    ROW_NUMBER() OVER (PARTITION BY version_id ORDER BY sort_key) - 1 AS sort_order,
    COUNT(*) FILTER (WHERE marker_type = 'chapter_marker') OVER (
      PARTITION BY version_id ORDER BY sort_key
    ) AS chapter_seq
  FROM (
    SELECT DISTINCT ON (version_id, marker_block_id)
      version_id,
      marker_block_id,
      marker_snapshot_id,
      legacy_scene_id,
      marker_meta,
      marker_type,
      sort_key,
      snapshot_id
    FROM marker_rows
    ORDER BY
      version_id,
      marker_block_id,
      CASE WHEN COALESCE(
        NULLIF(marker_meta->>'name', ''),
        NULLIF(marker_meta->>'number', ''),
        NULLIF(marker_meta->>'synopsis', ''),
        NULLIF(marker_meta->>'actionLine', ''),
        NULLIF(marker_meta->>'music', ''),
        NULLIF(marker_meta->>'stageNotes', ''),
        NULLIF(marker_meta->>'expectedDuration', '')
      ) IS NOT NULL THEN 0 ELSE 1 END,
      sort_key DESC,
      snapshot_id DESC
  ) unique_rows
),
marker_scenes AS (
  SELECT
    mr.version_id,
    mr.marker_block_id,
    mr.legacy_scene_id,
    mr.marker_meta,
    mr.sort_order,
    CASE
      WHEN mr.marker_type = 'chapter_marker' THEN NULL
      ELSE (
        SELECT chapter.marker_block_id
        FROM unique_marker_rows chapter
        WHERE chapter.version_id = mr.version_id
          AND chapter.marker_type = 'chapter_marker'
          AND chapter.chapter_seq = mr.chapter_seq
        ORDER BY chapter.sort_key DESC
        LIMIT 1
      )
    END AS parent_marker_id
  FROM unique_marker_rows mr
),
scene_metadata AS (
  SELECT
    ms.version_id,
    ms.marker_block_id,
    COALESCE(NULLIF(legacy_sv.num, ''), NULLIF(marker_sv.num, ''), NULLIF(ms.marker_meta->>'number', ''), '') AS num,
    COALESCE(NULLIF(legacy_sv.name, ''), NULLIF(marker_sv.name, ''), NULLIF(ms.marker_meta->>'name', ''), '') AS name,
    COALESCE(NULLIF(legacy_sv.synopsis, ''), NULLIF(marker_sv.synopsis, ''), NULLIF(ms.marker_meta->>'synopsis', '')) AS synopsis,
    COALESCE(NULLIF(legacy_sv.action_line, ''), NULLIF(marker_sv.action_line, ''), NULLIF(ms.marker_meta->>'actionLine', '')) AS action_line,
    COALESCE(NULLIF(legacy_sv.music, ''), NULLIF(marker_sv.music, ''), NULLIF(ms.marker_meta->>'music', '')) AS music,
    COALESCE(NULLIF(legacy_sv.stage_notes, ''), NULLIF(marker_sv.stage_notes, ''), NULLIF(ms.marker_meta->>'stageNotes', '')) AS stage_notes,
    COALESCE(NULLIF(legacy_sv.expected_duration, ''), NULLIF(marker_sv.expected_duration, ''), NULLIF(ms.marker_meta->>'expectedDuration', '')) AS expected_duration
  FROM marker_scenes ms
  LEFT JOIN scene_version legacy_sv
    ON legacy_sv.version_id = ms.version_id
   AND legacy_sv.scene_id = ms.legacy_scene_id
   AND ms.legacy_scene_id IS NOT NULL
   AND ms.legacy_scene_id <> ms.marker_block_id
  LEFT JOIN scene_version marker_sv
    ON marker_sv.version_id = ms.version_id
   AND marker_sv.scene_id = ms.marker_block_id
),
synced_markers AS (
  UPDATE script s
  SET marker_meta = COALESCE(s.marker_meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'number', NULLIF(sm.num, ''),
    'name', sm.name,
    'parentMarkerId', ms.parent_marker_id,
    'synopsis', sm.synopsis,
    'actionLine', sm.action_line,
    'music', sm.music,
    'stageNotes', sm.stage_notes,
    'expectedDuration', sm.expected_duration
  ))
  FROM unique_marker_rows mr
  JOIN marker_scenes ms
    ON ms.version_id = mr.version_id
   AND ms.marker_block_id = mr.marker_block_id
  JOIN scene_metadata sm
    ON sm.version_id = mr.version_id
   AND sm.marker_block_id = mr.marker_block_id
  WHERE s.id = mr.marker_snapshot_id
  RETURNING s.id
),
ensured_scene AS (
  INSERT INTO scene (id, production_id)
  SELECT DISTINCT ms.marker_block_id, v.production_id
  FROM marker_scenes ms
  JOIN version v ON v.id = ms.version_id
  ON CONFLICT (id) DO NOTHING
  RETURNING id
),
upserted_scene_versions AS (
  INSERT INTO scene_version (
    scene_id, version_id, num, name, sort_order, parent_id,
    synopsis, action_line, music, stage_notes, expected_duration
  )
  SELECT
    ms.marker_block_id,
    ms.version_id,
    sm.num,
    sm.name,
    ms.sort_order,
    ms.parent_marker_id,
    sm.synopsis,
    sm.action_line,
    sm.music,
    sm.stage_notes,
    sm.expected_duration
  FROM marker_scenes ms
  JOIN scene_metadata sm
    ON sm.version_id = ms.version_id
   AND sm.marker_block_id = ms.marker_block_id
  ON CONFLICT (scene_id, version_id) DO UPDATE
    SET num = EXCLUDED.num,
        name = EXCLUDED.name,
        sort_order = EXCLUDED.sort_order,
        parent_id = EXCLUDED.parent_id,
        synopsis = EXCLUDED.synopsis,
        action_line = EXCLUDED.action_line,
        music = EXCLUDED.music,
        stage_notes = EXCLUDED.stage_notes,
        expected_duration = EXCLUDED.expected_duration
  RETURNING scene_id
)
SELECT
  (SELECT COUNT(*) FROM synced_markers) AS marker_meta_synced,
  (SELECT COUNT(*) FROM upserted_scene_versions) AS marker_scene_versions_synced;

WITH marker_scene_ids AS (
  SELECT
    sv.version_id,
    sv.block_id AS scene_id
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE s.type IN ('chapter_marker', 'scene_marker')
),
deleted_legacy_scene_versions AS (
  DELETE FROM scene_version sv
  WHERE EXISTS (
      SELECT 1
      FROM marker_scene_ids ms
      WHERE ms.version_id = sv.version_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM marker_scene_ids ms
      WHERE ms.version_id = sv.version_id
        AND ms.scene_id = sv.scene_id
    )
  RETURNING 1
)
SELECT COUNT(*) AS legacy_scene_versions_pruned FROM deleted_legacy_scene_versions;

-- Text block ownership is inferred from marker order; keep direct ownership off
-- non-marker script snapshots so old scene IDs cannot diverge from markers.
UPDATE script s
SET scene_id = NULL,
    rehearsal_mark = NULL
WHERE s.type NOT IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
  AND (s.scene_id IS NOT NULL OR s.rehearsal_mark IS NOT NULL);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM script_version
    GROUP BY version_id, block_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'script_version still contains duplicate (version_id, block_id) rows after marker migration';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS script_version_version_block_uidx
  ON script_version(version_id, block_id);

COMMIT;
