import { getPool } from "../pg";
import { keyBetween } from "../lex-order";
import { broadcastWikiLibraryChange } from "./collab";
import { rowToWiki, type WikiListEntry, type WikiRow } from "./types";

// ─── wiki 树面（自 wiki-db.ts 拆出，PR-1 纯移动）：树位置/锚点/枚举面开关 ──────

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** 文档库列表（note 的 wiki 行 title 恒 NULL，不进库面）。可见性过滤由调用方做。 */
export async function listWikiLibrary(productionId: string): Promise<WikiListEntry[]> {
  const res = await getPool().query<WikiRow & { tags: string[] | null; is_anchor: boolean }>(
    `SELECT w.id::text AS id, w.production_id, w.title, w.created_by, w.parent_id::text AS parent_id,
            w.sort_key, w.is_public, w.listable, w.created_at, w.updated_at,
            '' AS body, '[]'::jsonb AS mentions,
            array_remove(array_agg(t.tag ORDER BY t.tag), NULL) AS tags,
            (EXISTS (SELECT 1 FROM production_wiki_config c
                     WHERE c.reports_root_wiki_id = w.id OR c.dramaturgy_root_wiki_id = w.id)
             OR EXISTS (SELECT 1 FROM production_event pe WHERE pe.report_doc_wiki_id = w.id)) AS is_anchor
     FROM wiki w LEFT JOIN wiki_tag t ON t.wiki_id = w.id
     WHERE w.production_id = $1 AND w.title IS NOT NULL
     GROUP BY w.id
     ORDER BY w.sort_key NULLS LAST, w.created_at`,
    [productionId],
  );
  return res.rows.map(r => {
    const { body: _b, mentions: _m, ...rest } = rowToWiki(r);
    return { ...rest, tags: r.tags ?? [], isAnchor: r.is_anchor };
  });
}

export async function validateParent(
  productionId: string, wikiId: string | null, parentId: string,
): Promise<boolean> {
  const pool = getPool();
  const p = await pool.query(
    `SELECT 1 FROM wiki WHERE id = $1::uuid AND production_id = $2`, [parentId, productionId]);
  if (!p.rows[0]) return false;
  if (!wikiId) return true;
  if (parentId === wikiId) return false;
  // 防环：沿 parent 链上溯不得遇到自己（递归 CTE，深度上限 100 防御异常数据）
  const cyc = await pool.query<{ hit: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, 1 AS depth FROM wiki WHERE id = $1::uuid
       UNION ALL
       SELECT w.id, w.parent_id, c.depth + 1 FROM wiki w JOIN chain c ON w.id = c.parent_id
       WHERE c.depth < 100
     )
     SELECT EXISTS (SELECT 1 FROM chain WHERE id = $2::uuid) AS hit`,
    [parentId, wikiId],
  );
  return !cyc.rows[0].hit;
}

/**
 * 同层兄弟集 = 真实子文档 ∪ 软链接别名（#358）。
 *
 * 别名有自己的 parent_id/sort_key，和真实子项挤在同一个父空间、共用同一把尺
 * （lex-order）。所以任何取键都必须在**并集**上算——只看 wiki 表会让新键和别名
 * 交错，和 #357 症状② 在残缺兄弟集上取键是同一个 bug 的两种成因。
 *
 * id 天然可辨：wiki 是 UUID、别名是 `wal_` 短 id，所以 excludeId 一个字段够用。
 */
async function siblingRows(
  productionId: string, parentId: string | null, excludeId: string | null,
): Promise<{ id: string; sort_key: string | null }[]> {
  const { rows } = await getPool().query<{ id: string; sort_key: string | null; created_at: string }>(
    `SELECT id::text AS id, sort_key, created_at FROM wiki
      WHERE production_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid
        AND ($3::text IS NULL OR id::text <> $3::text)
     UNION ALL
     SELECT id, sort_key, created_at FROM wiki_alias
      WHERE production_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid
        AND ($3::text IS NULL OR id <> $3::text)
     ORDER BY sort_key NULLS LAST, created_at`,
    [productionId, parentId, excludeId],
  );
  return rows;
}

/** 末尾排序键：同层最后一个（含别名）之后。 */
export async function tailSortKey(productionId: string, parentId: string | null): Promise<string> {
  const rows = await siblingRows(productionId, parentId, null);
  const last = [...rows].reverse().find(r => r.sort_key !== null);
  return keyBetween(last?.sort_key ?? null, null);
}

/**
 * 系统锚点判定（「报告」/「戏剧构作」根、event 目录文档）。与 listWikiLibrary 的
 * is_anchor、deleteWiki 的 anchor 守卫同一判据。
 *
 * 锚点是 INSERT 直建的**无主公共容器**——不走 createWiki，没有 created_by，
 * 不发创建者行集，所以全库没有任何人持它们的 *@edit（线上核实：12 个锚点 0 条
 * edit 行）。容器写门必须对它们豁免，否则默认文档树谁都放不进东西（#357 症状⑤）。
 */
export async function isWikiAnchor(wikiId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM production_wiki_config
     WHERE reports_root_wiki_id = $1::uuid OR dramaturgy_root_wiki_id = $1::uuid
     UNION ALL
     SELECT 1 FROM production_event WHERE report_doc_wiki_id = $1::uuid LIMIT 1`,
    [wikiId],
  );
  return rows.length > 0;
}

/**
 * 服务端在**完整**兄弟集上取排序键（#357 症状②）。
 *
 * 可枚举性逐节点之后，客户端手里的兄弟集可能有空洞——在残缺集上算 keyBetween
 * 会和看不见的兄弟交错。所以拖拽只传**相对锚点**（"放在 X 的前/后"），键一律
 * 由服务端在全量兄弟上算。顺带也修了并发拖拽下客户端快照过期的老问题。
 *
 * 锚点不在该父下（并发移动/客户端过期）→ 回落到尾部，不报错。
 */
export type WikiPlacement = { anchorId: string; side: "before" | "after" };

export async function placementSortKey(
  productionId: string, parentId: string | null,
  place: WikiPlacement, excludeId: string | null,
): Promise<string> {
  const rows = await siblingRows(productionId, parentId, excludeId);
  const idx = rows.findIndex(r => r.id === place.anchorId);
  if (idx < 0) return tailSortKey(productionId, parentId);
  const prev = place.side === "before" ? rows[idx - 1] : rows[idx];
  const next = place.side === "before" ? rows[idx] : rows[idx + 1];
  return keyBetween(prev?.sort_key ?? null, next?.sort_key ?? null);
}

/** 空串 → null（=根目录）。父 id 直接进 $n::uuid，空串会炸成
 *  "invalid input syntax for type uuid"——而"没有父文档"最自然的表达
 *  恰恰是空串，MCP 工具那边模型就这么传（人也一样）。在 db 层收口，
 *  所有写入来源（REST / MCP / 归档管线）一次性受益。 */
export function normalizeParentId(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() === "" ? null : (v ?? null);
}

// ─── 默认文档树（2026-08-16 拍板，路线笔记 §4 第 9 项）─────────────────────────
// 创建报告默认挂「报告」根目录 →「<event 标题>」事件目录之下；note 自动挂报告文档下。
// 锚点是普通 wiki（可改名/移动，锚认 id 不认位置）；目录文档完全公开（is_public）——
// 结构面推导，不发任何 grant 行。存量不迁移。

export type WikiTreeConfig = {
  enabled: boolean;
  rootTitle: string;
  rootWikiId: string | null;
};

export async function getWikiTreeConfig(productionId: string): Promise<WikiTreeConfig> {
  const res = await getPool().query<{ reports_tree_enabled: boolean; reports_root_title: string; reports_root_wiki_id: string | null }>(
    `SELECT reports_tree_enabled, reports_root_title, reports_root_wiki_id::text AS reports_root_wiki_id
     FROM production_wiki_config WHERE production_id = $1`,
    [productionId],
  );
  const r = res.rows[0];
  return r
    ? { enabled: r.reports_tree_enabled, rootTitle: r.reports_root_title, rootWikiId: r.reports_root_wiki_id }
    : { enabled: true, rootTitle: "报告", rootWikiId: null };
}

/** 「戏剧构作」根的**只读**读取。渲染路径只准用这个——ensureDramaturgyRootAnchor
 *  是带行锁的写事务，且会凭空建一篇 wiki，必须留在过完 wiki@create 门的写路径后面。 */
export async function getDramaturgyTreeConfig(productionId: string): Promise<WikiTreeConfig> {
  const res = await getPool().query<{ dramaturgy_tree_enabled: boolean; dramaturgy_root_title: string; dramaturgy_root_wiki_id: string | null }>(
    `SELECT dramaturgy_tree_enabled, dramaturgy_root_title, dramaturgy_root_wiki_id::text AS dramaturgy_root_wiki_id
     FROM production_wiki_config WHERE production_id = $1`,
    [productionId],
  );
  const r = res.rows[0];
  return r
    ? { enabled: r.dramaturgy_tree_enabled, rootTitle: r.dramaturgy_root_title, rootWikiId: r.dramaturgy_root_wiki_id }
    : { enabled: true, rootTitle: "戏剧构作", rootWikiId: null };
}

/**
 * 懒建报告树锚点（根目录文档 + event 目录文档），返回 event 目录 wiki id；
 * 配置关闭时返回 null。并发安全：config 行与 event 行 FOR UPDATE 串行化，
 * 锚点被删除时（FK SET NULL）自动重建。
 */
export async function ensureReportTreeAnchors(
  productionId: string,
  eventId: string,
): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO production_wiki_config (production_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [productionId],
    );
    const cfg = await client.query<{ reports_tree_enabled: boolean; reports_root_title: string; reports_root_wiki_id: string | null }>(
      `SELECT reports_tree_enabled, reports_root_title, reports_root_wiki_id::text AS reports_root_wiki_id
       FROM production_wiki_config WHERE production_id = $1 FOR UPDATE`,
      [productionId],
    );
    if (!cfg.rows[0]?.reports_tree_enabled) { await client.query("COMMIT"); return null; }

    let rootId = cfg.rows[0].reports_root_wiki_id;
    if (!rootId) {
      const lastRoot = await client.query<{ sort_key: string | null }>(
        `SELECT sort_key FROM wiki
         WHERE production_id = $1 AND parent_id IS NULL AND sort_key IS NOT NULL
         ORDER BY sort_key DESC LIMIT 1`,
        [productionId],
      );
      const rootRow = await client.query<{ id: string }>(
        `INSERT INTO wiki (production_id, title, is_public, sort_key)
         VALUES ($1, $2, true, $3) RETURNING id::text AS id`,
        [productionId, cfg.rows[0].reports_root_title, keyBetween(lastRoot.rows[0]?.sort_key ?? null, null)],
      );
      rootId = rootRow.rows[0].id;
      await client.query(
        `UPDATE production_wiki_config SET reports_root_wiki_id = $2::uuid, updated_at = now()
         WHERE production_id = $1`,
        [productionId, rootId],
      );
    }

    const ev = await client.query<{ report_doc_wiki_id: string | null; title: string }>(
      `SELECT report_doc_wiki_id::text AS report_doc_wiki_id, title
       FROM production_event WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [eventId, productionId],
    );
    if (!ev.rows[0]) { await client.query("ROLLBACK"); return null; }

    let eventDocId = ev.rows[0].report_doc_wiki_id;
    if (!eventDocId) {
      const lastChild = await client.query<{ sort_key: string | null }>(
        `SELECT sort_key FROM wiki
         WHERE parent_id = $1::uuid AND sort_key IS NOT NULL
         ORDER BY sort_key DESC LIMIT 1`,
        [rootId],
      );
      const docRow = await client.query<{ id: string }>(
        `INSERT INTO wiki (production_id, title, is_public, parent_id, sort_key)
         VALUES ($1, $2, true, $3::uuid, $4) RETURNING id::text AS id`,
        [productionId, ev.rows[0].title, rootId, keyBetween(lastChild.rows[0]?.sort_key ?? null, null)],
      );
      eventDocId = docRow.rows[0].id;
      await client.query(
        `UPDATE production_event SET report_doc_wiki_id = $2::uuid WHERE id = $1`,
        [eventId, eventDocId],
      );
    }

    await client.query("COMMIT");
    return eventDocId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 懒建「戏剧构作」单层系统根，返回根 wiki id；配置关闭时返回 null。
 * 并发/重建语义与 ensureReportTreeAnchors 同款（FOR UPDATE 串行化、
 * 锚被删则 FK SET NULL 后自动重建），只是没有第二层。
 */
export async function ensureDramaturgyRootAnchor(productionId: string): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO production_wiki_config (production_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [productionId],
    );
    const cfg = await client.query<{ dramaturgy_tree_enabled: boolean; dramaturgy_root_title: string; dramaturgy_root_wiki_id: string | null }>(
      `SELECT dramaturgy_tree_enabled, dramaturgy_root_title, dramaturgy_root_wiki_id::text AS dramaturgy_root_wiki_id
       FROM production_wiki_config WHERE production_id = $1 FOR UPDATE`,
      [productionId],
    );
    if (!cfg.rows[0]?.dramaturgy_tree_enabled) { await client.query("COMMIT"); return null; }

    let rootId = cfg.rows[0].dramaturgy_root_wiki_id;
    if (!rootId) {
      const lastRoot = await client.query<{ sort_key: string | null }>(
        `SELECT sort_key FROM wiki
         WHERE production_id = $1 AND parent_id IS NULL AND sort_key IS NOT NULL
         ORDER BY sort_key DESC LIMIT 1`,
        [productionId],
      );
      const rootRow = await client.query<{ id: string }>(
        `INSERT INTO wiki (production_id, title, is_public, sort_key)
         VALUES ($1, $2, true, $3) RETURNING id::text AS id`,
        [productionId, cfg.rows[0].dramaturgy_root_title, keyBetween(lastRoot.rows[0]?.sort_key ?? null, null)],
      );
      rootId = rootRow.rows[0].id;
      await client.query(
        `UPDATE production_wiki_config SET dramaturgy_root_wiki_id = $2::uuid, updated_at = now()
         WHERE production_id = $1`,
        [productionId, rootId],
      );
    }
    await client.query("COMMIT");
    return rootId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 把 wiki 挂到指定父节点尾部（默认落位/收编共用）。parent 须同 production。 */
export async function placeWikiUnder(
  wikiId: string,
  productionId: string,
  parentWikiId: string,
): Promise<void> {
  const sortKey = await tailSortKey(productionId, parentWikiId);
  await getPool().query(
    `UPDATE wiki SET parent_id = $3::uuid, sort_key = $4, updated_at = now()
     WHERE id = $1::uuid AND production_id = $2
       AND EXISTS (SELECT 1 FROM wiki p WHERE p.id = $3::uuid AND p.production_id = $2)`,
    [wikiId, productionId, parentWikiId, sortKey],
  );
}

// ─── 分享面 ──────────────────────────────────────────────────────────────────

/** 可枚举性开关（#357）。属分享面（grants@edit），与 setWikiPublic 同档。 */
export async function setWikiListable(id: string, productionId: string, listable: boolean): Promise<void> {
  await getPool().query(
    `UPDATE wiki SET listable = $3, updated_at = now() WHERE id = $1::uuid AND production_id = $2`,
    [id, productionId, listable],
  );
  broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId: id });
}

export async function setWikiDeptShares(id: string, productionId: string, deptIds: string[]): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM wiki_dept_share WHERE wiki_id = $1::uuid`, [id]);
  if (deptIds.length === 0) return;
  await pool.query(
    `INSERT INTO wiki_dept_share (wiki_id, dept_id)
     SELECT $1::uuid, d.id FROM production_dept d
     WHERE d.id = ANY($2::uuid[]) AND d.production_id = $3
     ON CONFLICT DO NOTHING`,
    [id, deptIds, productionId],
  );
}

export async function listWikiDeptShares(id: string): Promise<string[]> {
  const res = await getPool().query<{ dept_id: string }>(
    `SELECT dept_id::text AS dept_id FROM wiki_dept_share WHERE wiki_id = $1::uuid`, [id]);
  return res.rows.map(r => r.dept_id);
}
