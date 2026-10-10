import { getPool } from "../pg";
import { MARKER_TYPES_SQL } from "./script-marker-sql";

const ORDERED_BLOCKS_SQL = `SELECT sv.block_id AS id, s.id AS snapshot_id, s.type, s.content, s.stage_comment,
  (row_number() OVER (ORDER BY sv.sort_key) - 1)::int AS index
  FROM script_version sv JOIN script s ON s.id = sv.snapshot_id WHERE sv.version_id = $1`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** 编辑器需要所有命中定位，不需要正文；保留去 HTML 标签、LIKE/ILIKE 的原契约。 */
export async function searchScriptBlockMatches(versionId: string, query: string, exact: boolean) {
  const { rows } = await getPool().query<{ id: string; index: number }>(
    `WITH ordered AS (${ORDERED_BLOCKS_SQL})
     SELECT id, index FROM ordered
      WHERE type NOT IN (${MARKER_TYPES_SQL})
        AND regexp_replace(content, '<[^>]+>', '', 'g') ${exact ? "LIKE" : "ILIKE"} $2 ESCAPE E'\\\\'
      ORDER BY index`, [versionId, `%${escapeLike(query)}%`],
  );
  return rows;
}

export type ScriptTextHit = { id: string; index: number; from: "content" | "stageComment" };

/** Agent 包含匹配：一块只算一次、正文优先，角色用 EXISTS 避免多说话人重复计数。 */
export async function searchScriptTextHits(versionId: string, query: string, speakerIds: string[] | null, limit: number) {
  const { rows } = await getPool().query<{ total: string; hits: ScriptTextHit[] }>(
    `WITH ordered AS (${ORDERED_BLOCKS_SQL}), hits AS (
       SELECT id, index,
              CASE WHEN strpos(lower(content), $2) > 0 THEN 'content' ELSE 'stageComment' END AS "from"
         FROM ordered
        WHERE type NOT IN (${MARKER_TYPES_SQL})
          AND (strpos(lower(content), $2) > 0 OR strpos(lower(COALESCE(stage_comment, '')), $2) > 0)
          AND ($3::text[] IS NULL OR EXISTS (
            SELECT 1 FROM script_character sc
             WHERE sc.script_id = ordered.snapshot_id AND sc.character_id = ANY($3::text[])
          ))
     )
     SELECT (SELECT count(*)::text FROM hits) AS total,
            COALESCE((SELECT jsonb_agg(shown ORDER BY shown.index)
                        FROM (SELECT * FROM hits ORDER BY index LIMIT $4) shown), '[]'::jsonb) AS hits`,
    [versionId, query.toLowerCase(), speakerIds, limit],
  );
  return { total: Number(rows[0].total), hits: rows[0].hits };
}
