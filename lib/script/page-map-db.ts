import { getPool } from "../pg";
import type { Block, ScriptState } from "./script-types";
import { computePageMap, updateEstimatedPageMap, type EstimatedPageMapCache } from "./script-page";
import { isKnownTemplateId } from "./template";
import { scriptViewLayout } from "./script-view-db";
import { loadVersionBlocks } from "./script-block-read-db";

// 页码缓存 production.page_map（#486 从 lib/db.ts 搬出）：读侧 getEstimatedPageMap 是全站
// 唯一的页码读口（#336），写侧 scheduleEstimatedPageMapSave 由 applyPatchToDB 提交后与
// saveScriptConfig 改版式时触发。进程内缓存与在途写入表挂 globalThis，dev 热重载不丢。

const pageMapGlobals = globalThis as typeof globalThis & {
  __scriptPageMapCache?: Map<string, EstimatedPageMapCache>;
  __scriptPageMapUpdates?: Map<string, Promise<void>>;
};

const pageMapCache = pageMapGlobals.__scriptPageMapCache ??= new Map();
const pageMapUpdates = pageMapGlobals.__scriptPageMapUpdates ??= new Map();

/** Load the pre-computed page map for a production (keyed by script_view id → blockId → page). */
export async function loadPageMap(productionId: string): Promise<Record<string, Record<string, number>> | null> {
  const res = await getPool().query<{ page_map: Record<string, Record<string, number>> | null }>(
    "SELECT page_map FROM production WHERE id = $1",
    [productionId]
  );
  return res.rows[0]?.page_map ?? null;
}

/**
 * 估算页码的统一读口（#336 阶段 B）。
 *
 * 页码有且只有这一个读者：读 `production.page_map`——applyPatchToDB 提交后按四种
 * 版式各预算一份、saveScriptConfig 改版式时全量重算的那份——再按演出**实际**版式取。
 * 此前四个消费点各自拉全本现算，其中三处硬编码 a4/center、cue 页漏传 textLayoutMode：
 * 用 letter / compact 的剧组，搜索与 @提及 报的是别的版式的页码。
 *
 * 存储缺失（从未写过、非 head 版本、上次 fire-and-forget 失败）时现算兜底；算法与
 * 存储同源（computePageMap），两边不会分叉。阶段 B2 起 page_map 改按 script_view id
 * 键，只需改这里。「页码到底该是什么」（实时重算 / 锁页 A 页 / 换坐标）归 #349。
 */
export async function getEstimatedPageMap(
  productionId: string,
  versionId: string,
  preloaded?: ScriptState | null,
): Promise<Record<string, number>> {
  // 存储由提交后的异步任务写入；等在途的那次写完，别读到上一版的页码
  await pageMapUpdates.get(versionId)?.catch(() => {});
  const res = await getPool().query<{
    page_map: Record<string, Record<string, number>> | null;
    active_version_id: string | null;
    master_view_id: string | null;
    page_layout: string | null;
    text_layout_mode: string | null;
    template_id: string | null;
  }>(
    `SELECT p.page_map, p.active_version_id, p.master_view_id, sv.page_layout, sv.text_layout_mode,
            sv.template_overrides->>'templateId' AS template_id
     FROM production p
     LEFT JOIN script_view sv ON sv.id = p.master_view_id
     WHERE p.id = $1`,
    [productionId],
  );
  const row = res.rows[0];
  if (!row) return {};
  // 页码 = 主本的页码（epic 决策 1 给 #349 留的位置）；page_map 按 view id 键
  if (row.active_version_id === versionId && row.master_view_id) {
    const stored = row.page_map?.[row.master_view_id];
    if (stored) return stored;
  }
  // 兜底重算只吃 blocks——别为它扛整本（#461）
  const blocks = preloaded?.blocks ?? (await loadVersionBlocks(versionId)).blocks;
  const { pageLayout, textLayoutMode } = scriptViewLayout(row);
  return computePageMap(blocks, pageLayout, textLayoutMode, false, isKnownTemplateId(row.template_id) ? row.template_id : null);
}

/** Stores a pre-computed page map keyed by script_view id（测试与修复脚本用；线上写入走 saveEstimatedPageMaps）. */
export async function savePageMap(
  productionId: string,
  pageMap: Record<string, Record<string, number>>,
): Promise<void> {
  deletePageMapCacheEntries(`${productionId}:`);
  await writePageMap(productionId, pageMap);
}

function deletePageMapCacheEntries(prefix: string): void {
  for (const key of pageMapCache.keys()) {
    if (key.startsWith(prefix)) pageMapCache.delete(key);
  }
}

async function writePageMap(
  productionId: string,
  pageMap: Record<string, Record<string, number>>,
): Promise<void> {
  await getPool().query(
    "UPDATE production SET page_map = $1 WHERE id = $2 AND page_map IS DISTINCT FROM $1::jsonb",
    [JSON.stringify(pageMap), productionId]
  );
}

const PAGE_MAP_CACHE_LIMIT = 64;

function cacheEstimatedPageMap(key: string, cache: EstimatedPageMapCache): EstimatedPageMapCache {
  pageMapCache.delete(key);
  pageMapCache.set(key, cache);
  while (pageMapCache.size > PAGE_MAP_CACHE_LIMIT) {
    const oldest = pageMapCache.keys().next().value;
    if (oldest === undefined) break;
    pageMapCache.delete(oldest);
  }
  return cache;
}

async function saveEstimatedPageMaps(
  productionId: string,
  versionId: string,
  blocks: Block[],
  dirty: "full" | Array<{ start: number; end: number }>,
): Promise<void> {
  // 按现存视图各算一份（#336 B2：page_map 以 script_view id 为键）。本阶段只有主本；
  // 改版式时 saveScriptConfig 触发全量重算，所以不必再为「万一换版式」预算另外三份。
  const views = await getPool().query<{ id: string; page_layout: string | null; text_layout_mode: string | null; template_id: string | null }>(
    `SELECT id, page_layout, text_layout_mode, template_overrides->>'templateId' AS template_id
     FROM script_view WHERE production_id = $1 ORDER BY sort_order, created_at`,
    [productionId],
  );
  if (views.rows.length === 0) return;
  let changed = false;
  const computed = views.rows.map((view) => {
    const key = `${productionId}:${versionId}:${view.id}`;
    const { pageLayout, textLayoutMode } = scriptViewLayout(view);
    const previous = pageMapCache.get(key) ?? null;
    const cache = updateEstimatedPageMap(
      previous,
      blocks,
      pageLayout,
      textLayoutMode,
      false,
      previous ? dirty : "full",
      isKnownTemplateId(view.template_id) ? view.template_id : null,
    );
    if (cache !== previous) changed = true;
    return { key, viewId: view.id, cache };
  });
  if (!changed) return;
  await writePageMap(productionId, Object.fromEntries(
    computed.map(({ viewId, cache }) => [viewId, cache.pageMap]),
  ));
  for (const { key, cache } of computed) cacheEstimatedPageMap(key, cache);
}

export function scheduleEstimatedPageMapSave(
  productionId: string,
  versionId: string,
  dirty: "full" | Array<{ start: number; end: number }>,
): Promise<void> {
  const previous = pageMapUpdates.get(versionId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    try {
      // 只装 blocks（#461）：分页测算不吃 scenes/characters/config。事务内读的
      // 结构列没有 content，没法复用——高度估算要正文，这次读省不掉，但省成一路。
      // 版本存在性单独验：loadVersionBlocks 对已删版本返回空数组，不能拿它当哨兵。
      const [versionExists, loaded] = await Promise.all([
        getPool().query("SELECT 1 FROM version WHERE id = $1 AND production_id = $2", [versionId, productionId]),
        loadVersionBlocks(versionId),
      ]);
      if (versionExists.rows.length > 0) await saveEstimatedPageMaps(productionId, versionId, loaded.blocks, dirty);
    } catch (error) {
      deletePageMapCacheEntries(`${productionId}:${versionId}:`);
      throw error;
    }
  });
  pageMapUpdates.set(versionId, current);
  return current.finally(() => {
    if (pageMapUpdates.get(versionId) === current) pageMapUpdates.delete(versionId);
  });
}
