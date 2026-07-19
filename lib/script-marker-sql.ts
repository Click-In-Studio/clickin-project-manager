export const MARKER_TYPES_SQL = "'chapter_marker', 'scene_marker', 'rehearsal_marker'";

export const VERSION_MARKER_LABEL_ROWS_SQL = `
  SELECT sv.block_id AS id, s.type::text AS type, s.marker_meta,
         CASE WHEN s.type IN ('chapter_marker', 'scene_marker')
           THEN COALESCE(s.scene_id, sv.block_id)
         END AS legacy_scene_id
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE sv.version_id = $1 AND s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
  ORDER BY sv.sort_key`;

export const VERSION_SCENES_FROM_MARKERS_CTE = `
	  WITH marker_rows AS (
	    SELECT
	      sv.block_id,
	      sv.sort_key,
	      s.type::text AS type,
	      s.marker_meta,
	      sv.snapshot_id
	    FROM script_version sv
	    JOIN script s ON s.id = sv.snapshot_id
	    WHERE sv.version_id = $1
	      AND s.type IN ('chapter_marker', 'scene_marker')
	  ),
	  clean_marker_rows AS (
	    SELECT
	      block_id,
	      sort_key,
	      type,
	      marker_meta,
	      COUNT(*) FILTER (WHERE type = 'chapter_marker') OVER (ORDER BY sort_key) AS chapter_seq
	    FROM (
	      SELECT DISTINCT ON (block_id)
	        block_id,
	        sort_key,
	        type,
	        marker_meta,
	        snapshot_id
	      FROM marker_rows
	      ORDER BY
	        block_id,
	        CASE WHEN COALESCE(
	          NULLIF(marker_meta->>'name', ''),
	          NULLIF(marker_meta->>'synopsis', ''),
	          NULLIF(marker_meta->>'actionLine', ''),
	          NULLIF(marker_meta->>'music', ''),
	          NULLIF(marker_meta->>'stageNotes', ''),
	          NULLIF(marker_meta->>'expectedDuration', '')
	        ) IS NOT NULL THEN 0 ELSE 1 END,
	        sort_key DESC,
	        snapshot_id DESC
	    ) unique_marker_rows
	  ),
	  marker_scenes AS (
	    SELECT
	      mr.block_id AS id,
	      mr.sort_key,
      mr.marker_meta,
      ROW_NUMBER() OVER (ORDER BY mr.sort_key) - 1 AS sort_order,
      CASE
	        WHEN mr.type = 'chapter_marker' THEN NULL
	        ELSE (
	          SELECT chapter.block_id
	          FROM clean_marker_rows chapter
	          WHERE chapter.type = 'chapter_marker'
	            AND chapter.chapter_seq = mr.chapter_seq
	          ORDER BY chapter.sort_key DESC
	          LIMIT 1
	        )
	      END AS parent_id
	    FROM clean_marker_rows mr
	  )`;

export const VERSION_OWNED_BLOCKS_CTE = `
  WITH version_blocks AS (
    SELECT sv.block_id, sv.sort_key, s.type::text AS type, s.content, s.scene_id, s.rehearsal_mark, s.marker_meta
    FROM script_version sv
    JOIN script s ON s.id = sv.snapshot_id
    WHERE sv.version_id = $1
  ),
  scene_owned AS (
    SELECT *,
           COALESCE(
             MAX(CASE WHEN type IN ('chapter_marker', 'scene_marker') THEN block_id END) OVER (PARTITION BY scene_seq),
             scene_id
           ) AS owned_scene_id,
           COUNT(*) FILTER (WHERE type = 'rehearsal_marker')
             OVER (PARTITION BY scene_seq ORDER BY sort_key) AS rehearsal_seq
    FROM (
      SELECT *,
             COUNT(*) FILTER (WHERE type IN ('chapter_marker', 'scene_marker'))
               OVER (ORDER BY sort_key) AS scene_seq
      FROM version_blocks
    ) ordered_blocks
  ),
  rehearsal_owned AS (
    SELECT *,
           COALESCE(
             MAX(CASE WHEN type = 'rehearsal_marker' THEN block_id END) OVER (PARTITION BY scene_seq, rehearsal_seq),
             rehearsal_mark
           ) AS owned_rehearsal_mark
    FROM scene_owned
  ),
  owned_blocks AS (
    SELECT block_id AS id, sort_key, type, content,
           CASE WHEN type IN ('chapter_marker', 'scene_marker') THEN block_id ELSE owned_scene_id END AS scene_id,
           owned_rehearsal_mark AS rehearsal_mark,
           marker_meta
    FROM rehearsal_owned
  )`;
