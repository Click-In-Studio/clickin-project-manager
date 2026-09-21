import { getPool } from "../pg";
import type { Block, Character, Scene } from "./script-types";
import { generatedRehearsalMarksByScene } from "./script-generated-labels";
import { VERSION_OWNED_BLOCKS_CTE, VERSION_SCENES_FROM_MARKERS_CTE } from "./script-marker-sql";
import { projectMarkers, type MarkerProjection } from "./script-marker-domain";
import { getMarkerLabelIndex } from "./script-marker-label-db";
import { cleanMarkerMeta, fromDbType, isChapterSceneMarkerType, type BlockRow } from "./script-row-model";

// 场次 / 角色详情查询（#486 从 lib/db.ts 搬出，原段名「Contact import」早已名不副实）：
// 场次从标记块投影（VERSION_SCENES_FROM_MARKERS_CTE），角色读 character_version；
// 写侧只有角色元数据 patch 与聚合角色成员，块与场次的写走 applyPatchToDB。

export type CharacterDetail = Character & {
  gender: string;
  biography: string;
  roleType: string;
  memberIds: string[]; // IDs of constituent characters (only non-empty for aggregate)
};

export async function setCharacterMembers(productionId: string, aggregateId: string, memberIds: string[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const allIds = [...new Set([aggregateId, ...memberIds])];
    const ownerRes = await client.query<{ id: string }>(
      "SELECT id FROM character WHERE production_id = $1 AND id = ANY($2::text[])",
      [productionId, allIds]
    );
    if (ownerRes.rows.length !== allIds.length) {
      throw new Error("Character aggregate members must belong to the production");
    }
    await client.query("DELETE FROM character_aggregate WHERE aggregate_id = $1", [aggregateId]);
    if (memberIds.length > 0) {
      await client.query(
        `INSERT INTO character_aggregate (aggregate_id, member_id)
         SELECT $1::text, unnest($2::text[])`,
        [aggregateId, memberIds]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function patchCharacterMeta(
  id: string,
  versionId: string,
  fields: { gender?: string; biography?: string; roleType?: string }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id, versionId];
  if (fields.gender    !== undefined) { sets.push(`gender    = $${vals.push(fields.gender)}`); }
  if (fields.biography !== undefined) { sets.push(`biography = $${vals.push(fields.biography)}`); }
  if (fields.roleType  !== undefined) { sets.push(`role_type = $${vals.push(fields.roleType)}`); }
  if (!sets.length) return;
  await getPool().query(
    `UPDATE character_version SET ${sets.join(", ")} WHERE character_id = $1 AND version_id = $2`,
    vals
  );
}

export async function listScenesByVersion(versionId: string): Promise<SceneDetail[]> {
  const [res, labels] = await Promise.all([getPool().query<{
    id: string; name: string; parent_id: string | null;
    synopsis: string | null; action_line: string | null; music: string | null;
    stage_notes: string | null; expected_duration: string | null;
  }>(
    `${VERSION_SCENES_FROM_MARKERS_CTE}
     SELECT ms.id,
            COALESCE(ms.marker_meta->>'name', '') AS name,
            ms.parent_id,
            ms.marker_meta->>'synopsis' AS synopsis,
            ms.marker_meta->>'actionLine' AS action_line,
            ms.marker_meta->>'music' AS music,
            ms.marker_meta->>'stageNotes' AS stage_notes,
            ms.marker_meta->>'expectedDuration' AS expected_duration
     FROM marker_scenes ms
     ORDER BY ms.sort_key`,
    [versionId]
  ), getMarkerLabelIndex(versionId)]);
  return res.rows.map((r) => ({
    id: r.id, number: labels.labelByMarkerId.get(r.id) ?? "", name: r.name, parentId: r.parent_id,
    synopsis: r.synopsis ?? "",
    actionLine: r.action_line ?? "",
    music: r.music ?? "",
    stageNotes: r.stage_notes ?? "",
    expectedDuration: r.expected_duration ?? "",
  }));
}

export async function listCharactersByVersion(versionId: string): Promise<CharacterDetail[]> {
  const pool = getPool();
  const [charsRes, membersRes] = await Promise.all([
    pool.query<{
      id: string; name: string; is_aggregate: boolean;
      gender: string | null; biography: string | null; role_type: string | null;
    }>(
      `SELECT character_id AS id, name, is_aggregate, gender, biography, role_type
       FROM character_version
       WHERE version_id = $1
       ORDER BY sort_order`,
      [versionId]
    ),
    pool.query<{ aggregate_id: string; member_id: string }>(
      `SELECT ca.aggregate_id, ca.member_id FROM character_aggregate ca
       JOIN character_version cv ON cv.character_id = ca.aggregate_id
       WHERE cv.version_id = $1`,
      [versionId]
    ),
  ]);
  const memberMap = new Map<string, string[]>();
  for (const row of membersRes.rows) {
    if (!memberMap.has(row.aggregate_id)) memberMap.set(row.aggregate_id, []);
    memberMap.get(row.aggregate_id)!.push(row.member_id);
  }
  return charsRes.rows.map((r) => ({
    id: r.id, name: r.name, isAggregate: r.is_aggregate,
    gender: r.gender ?? "",
    biography: r.biography ?? "",
    roleType: r.role_type ?? "",
    memberIds: memberMap.get(r.id) ?? [],
  }));
}

export async function listRehearsalMarksByVersion(versionId: string): Promise<Record<string, string[]>> {
  const res = await getPool().query<{ scene_id: string | null; rehearsal_mark: string | null; type: string }>(
    `${VERSION_OWNED_BLOCKS_CTE}
     SELECT scene_id, rehearsal_mark, type
     FROM owned_blocks
     ORDER BY sort_key`,
    [versionId]
  );
  return generatedRehearsalMarksByScene(res.rows.map((row) => ({
    sceneId: row.scene_id,
    rehearsalMark: row.rehearsal_mark,
    type: row.type,
  })));
}


/** productionId 是隔离护栏：id 属于别的项目时返回 null，不泄漏。 */
export async function getCharacterById(id: string, productionId: string, versionId: string): Promise<CharacterDetail | null> {
  const pool = getPool();
  const [charRes, membersRes] = await Promise.all([
    pool.query<{
      id: string; name: string; is_aggregate: boolean;
      gender: string | null; biography: string | null; role_type: string | null;
    }>(
      `SELECT cv.character_id AS id, cv.name, cv.is_aggregate, cv.gender, cv.biography, cv.role_type
       FROM character_version cv
       JOIN character c ON c.id = cv.character_id
       WHERE cv.character_id = $1 AND c.production_id = $2 AND cv.version_id = $3`,
      [id, productionId, versionId]
    ),
    pool.query<{ member_id: string }>(
      "SELECT member_id FROM character_aggregate WHERE aggregate_id = $1",
      [id]
    ),
  ]);
  const r = charRes.rows[0];
  return r ? {
    id: r.id, name: r.name, isAggregate: r.is_aggregate,
    gender: r.gender ?? "", biography: r.biography ?? "", roleType: r.role_type ?? "",
    memberIds: membersRes.rows.map((m) => m.member_id),
  } : null;
}

export type SceneDetail = Scene & {
  synopsis: string;
  actionLine: string;
  music: string;
  stageNotes: string;
  expectedDuration: string;
};

export async function listMarkerProjectionByVersion(
  versionId: string,
): Promise<MarkerProjection[]> {
  const [blocksRes, labels] = await Promise.all([
    getPool().query<Pick<BlockRow, "block_id" | "scene_id" | "marker_meta" | "type">>(
      `SELECT sv.block_id, s.scene_id, s.marker_meta, s.type
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
         AND s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
       ORDER BY sv.sort_key`,
      [versionId],
    ),
    getMarkerLabelIndex(versionId),
  ]);
  const blocks: Block[] = blocksRes.rows.map((row) => {
    const { type, lyric } = fromDbType(row.type);
    return {
      id: row.block_id,
      type,
      lyric,
      content: "",
      forceShowCharacterName: false,
      sceneId: isChapterSceneMarkerType(row.type) ? row.block_id : row.scene_id,
      rehearsalMark: null,
      markerMeta: cleanMarkerMeta(row.marker_meta),
      characterIds: [],
      characterAnnotations: {},
    };
  });
  return projectMarkers({ blocks, scenes: [] }, [], labels);
}

/** productionId 是隔离护栏：version 不属于该项目时返回 null，不泄漏。 */
export async function getSceneById(
  sceneId: string, productionId: string, versionId: string,
): Promise<SceneDetail | null> {
  const owner = await getPool().query(
    "SELECT 1 FROM version WHERE id = $1 AND production_id = $2",
    [versionId, productionId],
  );
  if (owner.rows.length === 0) return null;
  const markerScenes = await listScenesByVersion(versionId);
  return markerScenes.find((scene) => scene.id === sceneId) ?? null;
}
