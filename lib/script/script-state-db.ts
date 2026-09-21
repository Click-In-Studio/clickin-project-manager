import { getPool } from "../pg";
import type { ScriptState, ScriptConfig } from "./script-types";
import { DEFAULT_SCRIPT_CONFIG } from "./script-types";
import { ensureMasterScriptView, scriptViewLayout } from "./script-view-db";
import { isKnownTemplateId } from "./template";
import { buildMarkerLabelIndex } from "./script-generated-labels";
import { VERSION_SCENES_FROM_MARKERS_CTE } from "./script-marker-sql";
import type { CharRow, SceneRow } from "./script-row-model";
import { loadVersionBlocks } from "./script-block-read-db";
import { scheduleEstimatedPageMapSave } from "./page-map-db";

// 整本剧本状态与 script_config（#486 从 lib/db.ts 搬出）：loadProduction 装某 version 的
// 全部状态（块 / 场次 / 角色 / 配置），getScriptConfig / saveScriptConfig 读写三层合并的配置
// （production ← version ← 主本视图）。saveScriptConfig 改版式时触发 page-map 全量重算。

export type LoadedScriptState = {
  state: ScriptState;
  sortKeys: Map<string, string>;    // block_id → sort_key
  snapshotIds: Map<string, string>; // block_id → snapshot_id
};

const PRODUCTION_CONFIG_SQL = `SELECT p.script_config AS production_script_config,
        v.script_config AS version_script_config,
        sv.page_layout, sv.text_layout_mode,
        sv.template_overrides->>'templateId' AS template_id
 FROM production p
 JOIN version v ON v.production_id = p.id
 LEFT JOIN script_view sv ON sv.id = p.master_view_id
 WHERE p.id = $1 AND v.id = $2`;

type ProductionConfigRow = {
  production_script_config: Partial<ScriptConfig> | null;
  version_script_config: Partial<ScriptConfig> | null;
  page_layout: string | null;
  text_layout_mode: string | null;
  template_id: string | null;
};

/** ScriptConfig 的唯一装配口（loadProduction 与 getScriptConfig 共用）。
 *  openingChapterMarkerId 配置无效（缺失/指向已不存在的章 marker）时兜底到第一章；
 *  兜底值经 backfillOpeningChapterMarkerId 返回，由 loadProduction 决定是否写回。 */
function assembleScriptConfig(
  row: ProductionConfigRow,
  chapterMarkerIds: string[],
): { config: ScriptConfig; backfillOpeningChapterMarkerId: string | null } {
  // 版式只有 script_view 一处真相（#336 B2）：主本行装配进 ScriptConfig，JSONB 里
  // 即便残留旧键也不算数。无主本（不应发生）落缺省。
  const masterLayout = scriptViewLayout(row);
  // 排版模版 id 也住在主本上（template_overrides.templateId，#338 T3）；不认识的 id 当没有
  const templateId = isKnownTemplateId(row.template_id) ? row.template_id : null;
  const rawVersionConfig = row.version_script_config;
  let openingChapterMarkerId =
    typeof rawVersionConfig?.openingChapterMarkerId === "string"
      ? rawVersionConfig.openingChapterMarkerId
      : null;
  let backfillOpeningChapterMarkerId: string | null = null;
  if (!openingChapterMarkerId || !chapterMarkerIds.includes(openingChapterMarkerId)) {
    openingChapterMarkerId = chapterMarkerIds[0] ?? null;
    backfillOpeningChapterMarkerId = openingChapterMarkerId;
  }
  // 后者覆盖前者：主本的版式与模版 id 压过 JSONB 里的残留键（scriptViewLayout 只产出
  // pageLayout / textLayoutMode 两个键，templateId 单独装配）
  return {
    config: {
      ...DEFAULT_SCRIPT_CONFIG,
      ...(row.production_script_config ?? {}),
      ...(rawVersionConfig ?? {}),
      ...masterLayout,
      templateId,
      openingChapterMarkerId,
    },
    backfillOpeningChapterMarkerId,
  };
}

/** 只装配 ScriptConfig，不拖 blocks/scenes/characters（#461）。与 loadProduction
 *  同一套装配，但纯读——不做 openingChapterMarkerId 的写回。 */
export async function getScriptConfig(productionId: string, versionId: string): Promise<ScriptConfig | null> {
  const pool = getPool();
  const [prodRes, chapterRes] = await Promise.all([
    pool.query<ProductionConfigRow>(PRODUCTION_CONFIG_SQL, [productionId, versionId]),
    pool.query<{ block_id: string }>(
      `SELECT sv.block_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1 AND s.type = 'chapter_marker'
       ORDER BY sv.sort_key`,
      [versionId]
    ),
  ]);
  if (!prodRes.rows.length) return null;
  return assembleScriptConfig(prodRes.rows[0], chapterRes.rows.map(r => r.block_id)).config;
}

/**
 * Load all data for a specific version of a production.
 * Returns null if the production doesn't exist.
 */
export async function loadProduction(productionId: string, versionId: string): Promise<LoadedScriptState | null> {
  const pool = getPool();

  const [[loadedBlocks, scenesRes, charsRes], prodRes] = await Promise.all([
	    Promise.all([
	      loadVersionBlocks(versionId),
      pool.query<SceneRow>(
        `${VERSION_SCENES_FROM_MARKERS_CTE}
         SELECT ms.id,
                COALESCE(ms.marker_meta->>'name', '') AS name,
                ms.sort_order, ms.parent_id
         FROM marker_scenes ms
         ORDER BY ms.sort_order`,
        [versionId]
      ),
      pool.query<CharRow>(
        `SELECT cv.character_id AS id, cv.name, cv.sort_order, cv.is_aggregate,
                COALESCE(array_remove(array_agg(ca.member_id ORDER BY ca.member_id), NULL), ARRAY[]::text[]) AS member_ids
         FROM character_version cv
         LEFT JOIN character_aggregate ca ON ca.aggregate_id = cv.character_id
         WHERE cv.version_id = $1
         GROUP BY cv.character_id, cv.name, cv.sort_order, cv.is_aggregate
         ORDER BY cv.sort_order`,
        [versionId]
      ),
    ]),
    pool.query<ProductionConfigRow>(PRODUCTION_CONFIG_SQL, [productionId, versionId]),
  ]);

  if (!prodRes.rows.length) return null;
  const { blocks, sortKeys, snapshotIds } = loadedBlocks;
  const markerLabels = buildMarkerLabelIndex(blocks);

  const { config, backfillOpeningChapterMarkerId } = assembleScriptConfig(
    prodRes.rows[0],
    blocks.filter((block) => block.type === "chapter_marker").map((block) => block.id),
  );
  if (backfillOpeningChapterMarkerId) {
    await pool.query(
      "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2",
      [JSON.stringify({ openingChapterMarkerId: backfillOpeningChapterMarkerId }), versionId]
    );
  }

  return {
    state: {
      blocks,
      scenes: scenesRes.rows.map(r => ({
        id: r.id,
        number: markerLabels.labelByMarkerId.get(r.id) ?? "",
        name: r.name,
        parentId: r.parent_id,
      })),
      characters: charsRes.rows.map(r => ({ id: r.id, name: r.name, isAggregate: r.is_aggregate, memberIds: r.member_ids ?? [] })),
      config,
    },
    sortKeys,
    snapshotIds,
  };
}

export async function saveScriptConfig(productionId: string, versionId: string | null, config: ScriptConfig): Promise<void> {
  // 三张表四条写包一个事务（#629）：中途失败不留「production 改了、主本版式没改」的静默不一致。
  const client = await getPool().connect();
  let paginationChanged = false;
  try {
    await client.query("BEGIN");
    // 版式不进 JSONB（#336 B2）：写主本的 script_view 行。
    const configJson = JSON.stringify({
      stageDelimOpen: config.stageDelimOpen,
      stageDelimClose: config.stageDelimClose,
      useRehearsalMarks: config.useRehearsalMarks,
    });
    await client.query("UPDATE production SET script_config = $1 WHERE id = $2", [configJson, productionId]);
    const masterViewId = await ensureMasterScriptView(productionId, client);
    // 模版 id 进 template_overrides（JSONB，保留将来的覆盖项）；null = 删掉键（按 textLayoutMode 回退）
    const templateId = isKnownTemplateId(config.templateId) ? config.templateId : null;
    const configUpdate = await client.query<{ pagination_changed: boolean }>(
      `WITH previous AS (
         SELECT page_layout, text_layout_mode, template_overrides->>'templateId' AS template_id
         FROM script_view WHERE id = $1
       ), updated AS (
         UPDATE script_view
            SET page_layout = $2,
                text_layout_mode = $3,
                template_overrides = CASE
                  WHEN $4::text IS NULL THEN COALESCE(template_overrides, '{}'::jsonb) - 'templateId'
                  ELSE COALESCE(template_overrides, '{}'::jsonb) || jsonb_build_object('templateId', $4::text)
                END
          WHERE id = $1 RETURNING 1
       )
       SELECT previous.page_layout IS DISTINCT FROM $2
           OR previous.text_layout_mode IS DISTINCT FROM $3
           OR previous.template_id IS DISTINCT FROM $4::text AS pagination_changed
       FROM previous, updated`,
      [masterViewId, config.pageLayout, config.textLayoutMode, templateId]
    );
    paginationChanged = configUpdate.rows[0]?.pagination_changed ?? false;
    if (versionId) {
      await client.query(
        "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2 AND production_id = $3",
        [JSON.stringify({
          openingChapterMarkerId: config.openingChapterMarkerId,
          showOpeningChapter: config.showOpeningChapter,
        }), versionId, productionId]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  // page-map 重算自己读库，必须在 COMMIT 之后触发，否则读到的还是旧版式。
  if (versionId && paginationChanged) {
    await scheduleEstimatedPageMapSave(productionId, versionId, "full");
  }
}
