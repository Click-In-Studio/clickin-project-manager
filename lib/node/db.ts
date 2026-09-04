import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "../pg";
import { keyBetween } from "../lex-order";
import { broadcastWikiLibraryChange } from "../wiki/collab";

/**
 * 系统锚点判据（SQL 布尔表达式模板，nodeIdExpr 是列引用或参数占位）。
 * 四个锚点来源：config 三根（报告/戏剧构作/资产）∪ event 目录。判据**只写这
 * 一份**供三个读者插值（listNodeLibrary 的 is_anchor 计算列 / isNodeAnchor /
 * deleteNode 守卫）——原 wiki 侧三份内联抄写的收敛（#420 风险清单第 7 条）。
 */
export function NODE_ANCHOR_EXISTS_SQL(nodeIdExpr: string): string {
  return `(EXISTS (SELECT 1 FROM production_node_config c
                   WHERE c.reports_root_node_id = ${nodeIdExpr}
                      OR c.dramaturgy_root_node_id = ${nodeIdExpr}
                      OR c.assets_root_node_id = ${nodeIdExpr})
           OR EXISTS (SELECT 1 FROM production_event pe
                      WHERE pe.report_doc_node_id = ${nodeIdExpr}))`;
}

// ─── node 树（epic #420）：树位置/排序/CRUD ──────────────────────────────────
//
// 壳节点模型：树节点是壳（位置+权限），内容对象另存——wiki 表管正文、asset 表管
// 文件。四 kind：folder / wiki / asset / link。规约（DB 唯一索引钉死）：一个
// wiki/asset 只对应一个 node。
//
// 树 = 内禀 parent_id + fractional sort_key（lib/lex-order.ts），逐字继承 wiki
// 树的全部拍板：服务端在完整兄弟集上取键（#357 症状②）、删父时子项上移一层
// （#352）、防环 CTE、空串 parent 收口。原 wiki∪wiki_alias 的 UNION 兄弟集
// 随合表消亡——单表即全兄弟，这是本次迁移最大的简化红利。
//
// 【容器规则】只有 folder 与 wiki 节点可作父；asset 与 link 是叶子。

export type NodeKind = "folder" | "wiki" | "asset" | "link";

export type NodeRecord = {
  id: string;
  productionId: string;
  kind: NodeKind;
  parentId: string | null;
  sortKey: string | null;
  isPublic: boolean;
  /** 可枚举性（#357 枚举面）：对能枚举父节点者是否出现在目录树。 */
  listable: boolean;
  wikiId: string | null;
  assetId: string | null;
  linkTargetId: string | null;
  /** folder 的名字；link 的显示名覆盖（null=跟随目标）；wiki/asset 恒 null。 */
  title: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 树条目：NodeRecord + 渲染用的解析结果（标题/tags/锚点位）。 */
export type NodeEntry = NodeRecord & {
  /** 解析后的显示标题：folder=title、wiki=正文标题、asset=name??fileName、
   *  link=displayTitle(title 列)??目标解析标题。 */
  displayTitle: string | null;
  /** link 专用：目标的实时标题（UI 要能说清「这是软链接 → 那篇叫什么」）。 */
  targetTitle: string | null;
  /** link 专用：目标节点 kind（前端按它分派点击行为）。 */
  targetKind: NodeKind | null;
  /** link 专用：目标为 wiki 时的内容 id（拖拽建引用等场景锚真实目标，#358 ⑦）。 */
  targetWikiId: string | null;
  tags: string[];
  /** 系统锚点（报告根/事件目录/灵感库根/资产根）：可移动可改名，不可删除。 */
  isAnchor: boolean;
};

export type NodeRow = {
  id: string; production_id: string; kind: NodeKind; parent_id: string | null;
  sort_key: string | null; is_public: boolean; listable: boolean;
  wiki_id: string | null; asset_id: string | null; link_target_id: string | null;
  title: string | null; created_by: string | null; created_at: Date; updated_at: Date;
};

export function rowToNode(r: NodeRow): NodeRecord {
  return {
    id: r.id, productionId: r.production_id, kind: r.kind, parentId: r.parent_id,
    sortKey: r.sort_key, isPublic: r.is_public, listable: r.listable,
    wikiId: r.wiki_id, assetId: r.asset_id, linkTargetId: r.link_target_id,
    title: r.title, createdBy: r.created_by,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

export const NODE_SELECT_COLS = `id, production_id, kind, parent_id, sort_key, is_public, listable,
  wiki_id::text AS wiki_id, asset_id, link_target_id, title,
  created_by::text AS created_by, created_at, updated_at`;

export function newNodeId(): string {
  return `nd_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export async function getNode(id: string, productionId: string): Promise<NodeRecord | null> {
  const { rows } = await getPool().query<NodeRow>(
    `SELECT ${NODE_SELECT_COLS} FROM node WHERE id = $1 AND production_id = $2`,
    [id, productionId],
  );
  return rows[0] ? rowToNode(rows[0]) : null;
}

export async function getNodeByWikiId(wikiId: string): Promise<NodeRecord | null> {
  const { rows } = await getPool().query<NodeRow>(
    `SELECT ${NODE_SELECT_COLS} FROM node WHERE wiki_id = $1::uuid`, [wikiId]);
  return rows[0] ? rowToNode(rows[0]) : null;
}

export async function getNodeByAssetId(assetId: string): Promise<NodeRecord | null> {
  const { rows } = await getPool().query<NodeRow>(
    `SELECT ${NODE_SELECT_COLS} FROM node WHERE asset_id = $1`, [assetId]);
  return rows[0] ? rowToNode(rows[0]) : null;
}

type EntryRow = NodeRow & {
  wiki_title: string | null; wiki_body_absent: boolean | null;
  asset_name: string | null; asset_file_name: string | null;
  target_kind: NodeKind | null; target_wiki_id: string | null; target_wiki_title: string | null;
  target_asset_name: string | null; target_asset_file_name: string | null;
  target_folder_title: string | null;
  tags: string[] | null; is_anchor: boolean;
};

function rowToEntry(r: EntryRow): NodeEntry {
  const assetTitle = (name: string | null, file: string | null) => name ?? file;
  const targetTitle =
    r.kind !== "link" ? null
      : r.target_kind === "wiki" ? r.target_wiki_title
      : r.target_kind === "asset" ? assetTitle(r.target_asset_name, r.target_asset_file_name)
      : r.target_folder_title;
  const displayTitle =
    r.kind === "folder" ? r.title
      : r.kind === "wiki" ? r.wiki_title
      : r.kind === "asset" ? assetTitle(r.asset_name, r.asset_file_name)
      : (r.title ?? targetTitle);
  return {
    ...rowToNode(r), displayTitle, targetTitle,
    targetKind: r.kind === "link" ? r.target_kind : null,
    targetWikiId: r.kind === "link" ? r.target_wiki_id : null,
    tags: r.tags ?? [], isAnchor: r.is_anchor,
  };
}

const ENTRY_SELECT = `
  SELECT n.id, n.production_id, n.kind, n.parent_id, n.sort_key, n.is_public, n.listable,
         n.wiki_id::text AS wiki_id, n.asset_id, n.link_target_id, n.title,
         n.created_by::text AS created_by, n.created_at, n.updated_at,
         w.title AS wiki_title, NULL::boolean AS wiki_body_absent,
         a.name AS asset_name, a.file_name AS asset_file_name,
         t.kind AS target_kind, tw.id::text AS target_wiki_id, tw.title AS target_wiki_title,
         ta.name AS target_asset_name, ta.file_name AS target_asset_file_name,
         t.title AS target_folder_title,
         (SELECT array_remove(array_agg(wt.tag ORDER BY wt.tag), NULL)
          FROM wiki_tag wt WHERE wt.wiki_id = n.wiki_id) AS tags,
         ${NODE_ANCHOR_EXISTS_SQL("n.id")} AS is_anchor
  FROM node n
  LEFT JOIN wiki  w  ON w.id = n.wiki_id
  LEFT JOIN asset a  ON a.id = n.asset_id
  LEFT JOIN node  t  ON t.id = n.link_target_id
  LEFT JOIN wiki  tw ON tw.id = t.wiki_id
  LEFT JOIN asset ta ON ta.id = t.asset_id`;

/**
 * 库列表（树的全量节点，未过可见性——过滤由调用方 tree-view 做，同旧
 * listWikiLibrary 姿态）。两条隐式过滤：
 *   · note 的 wiki 行 title 恒 NULL，不进库面（原 listWikiLibrary 的 WHERE 迁来）
 *   · link 指向解析不到（目标已删的历史脏行）不出树——惰性兜底，不做失效占位
 */
export async function listNodeLibrary(productionId: string): Promise<NodeEntry[]> {
  const { rows } = await getPool().query<EntryRow>(
    `${ENTRY_SELECT}
     WHERE n.production_id = $1
       AND (n.kind <> 'wiki' OR w.title IS NOT NULL)
       AND (n.kind <> 'link' OR t.id IS NOT NULL)
     ORDER BY n.sort_key NULLS LAST, n.created_at`,
    [productionId],
  );
  return rows.map(rowToEntry);
}

/** 空串 → null（=根目录）。同旧 wiki 树的收口论证：MCP/REST 都会传空串。 */
export function normalizeParentId(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() === "" ? null : (v ?? null);
}

/** 容器判定：只有 folder 与 wiki 节点可作父（asset/link 是叶子）。 */
export async function validateParent(
  productionId: string, nodeId: string | null, parentId: string,
): Promise<boolean> {
  const pool = getPool();
  const p = await pool.query<{ kind: NodeKind }>(
    `SELECT kind FROM node WHERE id = $1 AND production_id = $2`, [parentId, productionId]);
  if (!p.rows[0]) return false;
  if (p.rows[0].kind !== "folder" && p.rows[0].kind !== "wiki") return false;
  if (!nodeId) return true;
  if (parentId === nodeId) return false;
  // 防环：沿 parent 链上溯不得遇到自己（深度上限 100 防御异常数据）
  const cyc = await pool.query<{ hit: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, 1 AS depth FROM node WHERE id = $1
       UNION ALL
       SELECT n.id, n.parent_id, c.depth + 1 FROM node n JOIN chain c ON n.id = c.parent_id
       WHERE c.depth < 100
     )
     SELECT EXISTS (SELECT 1 FROM chain WHERE id = $2) AS hit`,
    [parentId, nodeId],
  );
  return !cyc.rows[0].hit;
}

/** 同层兄弟集（单表——原 wiki∪alias 的 UNION 随合表消亡）。 */
async function siblingRows(
  productionId: string, parentId: string | null, excludeId: string | null,
): Promise<{ id: string; sort_key: string | null }[]> {
  const { rows } = await getPool().query<{ id: string; sort_key: string | null }>(
    `SELECT id, sort_key FROM node
      WHERE production_id = $1 AND parent_id IS NOT DISTINCT FROM $2
        AND ($3::text IS NULL OR id <> $3::text)
     ORDER BY sort_key NULLS LAST, created_at`,
    [productionId, parentId, excludeId],
  );
  return rows;
}

/** 末尾排序键：同层最后一个之后。 */
export async function tailSortKey(productionId: string, parentId: string | null): Promise<string> {
  const rows = await siblingRows(productionId, parentId, null);
  const last = [...rows].reverse().find(r => r.sort_key !== null);
  return keyBetween(last?.sort_key ?? null, null);
}

/** 相对锚点落位（#357 症状②）：客户端只说「放在谁的前/后」，键由服务端在
 *  完整兄弟集上算。锚点不在该父下（并发移动/客户端过期）→ 回落尾部不报错。 */
export type NodePlacement = { anchorId: string; side: "before" | "after" };

export async function placementSortKey(
  productionId: string, parentId: string | null,
  place: NodePlacement, excludeId: string | null,
): Promise<string> {
  const rows = await siblingRows(productionId, parentId, excludeId);
  const idx = rows.findIndex(r => r.id === place.anchorId);
  if (idx < 0) return tailSortKey(productionId, parentId);
  const prev = place.side === "before" ? rows[idx - 1] : rows[idx];
  const next = place.side === "before" ? rows[idx] : rows[idx + 1];
  return keyBetween(prev?.sort_key ?? null, next?.sort_key ?? null);
}

/** 事务内建壳节点（createWiki / createAsset / 报告归档管线复用）。
 *  external client＝调用方已在事务里，BEGIN/COMMIT/release 归调用方。 */
export async function insertNode(
  params: {
    productionId: string; kind: NodeKind;
    parentId: string | null; sortKey: string | null;
    wikiId?: string | null; assetId?: string | null; linkTargetId?: string | null;
    title?: string | null; isPublic?: boolean; listable?: boolean;
    createdBy: string | null;
  },
  external?: PoolClient,
): Promise<string> {
  const id = newNodeId();
  const q = external ?? getPool();
  await q.query(
    `INSERT INTO node (id, production_id, kind, parent_id, sort_key, is_public, listable,
                       wiki_id, asset_id, link_target_id, title, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10, $11, $12::uuid)`,
    [id, params.productionId, params.kind, params.parentId, params.sortKey,
     params.isPublic ?? false, params.listable ?? true,
     params.wikiId ?? null, params.assetId ?? null, params.linkTargetId ?? null,
     params.title ?? null, params.createdBy],
  );
  return id;
}

/** 位置面更新（parent/sort）。排序键优先级链：place > 显式 sortKey > 换父落尾部
 *  （换父不重算会留旧父的键——#357 顺手修的老 bug，规则保留）。 */
export async function moveNode(
  id: string, productionId: string,
  patch: { parentId?: string | null; sortKey?: string; place?: NodePlacement },
): Promise<NodeRecord | null> {
  const existing = await getNode(id, productionId);
  if (!existing) return null;
  const nextParentId = patch.parentId !== undefined ? normalizeParentId(patch.parentId) : undefined;
  if (nextParentId) {
    if (!await validateParent(productionId, id, nextParentId)) {
      throw new Error("非法的父节点（不存在、不可作容器或成环）");
    }
  }
  const targetParentId = nextParentId !== undefined ? nextParentId : existing.parentId;
  const nextSortKey = patch.place !== undefined
    ? await placementSortKey(productionId, targetParentId, patch.place, id)
    : patch.sortKey !== undefined
      ? patch.sortKey
      : (nextParentId !== undefined && nextParentId !== existing.parentId)
        ? await tailSortKey(productionId, targetParentId)
        : undefined;

  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id, productionId];
  const push = (frag: string, v: unknown) => { vals.push(v); sets.push(`${frag}$${vals.length}`); };
  if (nextParentId !== undefined) push("parent_id = ", nextParentId);
  if (nextSortKey !== undefined) push("sort_key = ", nextSortKey);
  if (sets.length > 1) {
    try {
      await getPool().query(
        `UPDATE node SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2`, vals);
    } catch (e) {
      // link 的同容器同目标唯一约束
      if (e instanceof Error && "code" in e && (e as { code?: string }).code === "23505") {
        throw new Error("duplicate_link_in_container");
      }
      throw e;
    }
    broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId: id });
  }
  return getNode(id, productionId);
}

/** 挂到指定父节点尾部（报告归档/收编共用）。parent 须同 production 且可作容器。 */
export async function placeNodeUnder(
  nodeId: string, productionId: string, parentNodeId: string, external?: PoolClient,
): Promise<void> {
  const q = external ?? getPool();
  const sortKey = await tailSortKey(productionId, parentNodeId);
  await q.query(
    `UPDATE node SET parent_id = $3, sort_key = $4, updated_at = now()
     WHERE id = $1 AND production_id = $2
       AND EXISTS (SELECT 1 FROM node p WHERE p.id = $3 AND p.production_id = $2
                   AND p.kind IN ('folder', 'wiki'))`,
    [nodeId, productionId, parentNodeId, sortKey],
  );
}

// ─── 分享树面（listable / is_public / dept_share 都在 node 上）────────────────

export async function setNodeListable(id: string, productionId: string, listable: boolean): Promise<void> {
  await getPool().query(
    `UPDATE node SET listable = $3, updated_at = now()
     WHERE id = $1 AND production_id = $2 AND kind <> 'link'`,
    [id, productionId, listable],
  );
  broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId: id });
}

export async function setNodePublic(id: string, productionId: string, isPublic: boolean): Promise<void> {
  await getPool().query(
    `UPDATE node SET is_public = $3, updated_at = now()
     WHERE id = $1 AND production_id = $2 AND kind <> 'link'`,
    [id, productionId, isPublic],
  );
}

export async function setNodeDeptShares(id: string, productionId: string, deptIds: string[]): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM node_dept_share WHERE node_id = $1`, [id]);
  if (deptIds.length === 0) return;
  await pool.query(
    `INSERT INTO node_dept_share (node_id, dept_id)
     SELECT $1, d.id FROM production_dept d
     WHERE d.id = ANY($2::uuid[]) AND d.production_id = $3
     ON CONFLICT DO NOTHING`,
    [id, deptIds, productionId],
  );
}

export async function listNodeDeptShares(id: string): Promise<string[]> {
  const res = await getPool().query<{ dept_id: string }>(
    `SELECT dept_id::text AS dept_id FROM node_dept_share WHERE node_id = $1`, [id]);
  return res.rows.map(r => r.dept_id);
}

// ─── 删除 ────────────────────────────────────────────────────────────────────

export type DeleteNodeResult =
  | { ok: true }
  | { ok: false; reason: "mounted" | "anchor" | "not_found" | "has_asset" };

/**
 * 删除节点（wiki/folder/link kind）。逐字继承 deleteWiki 的事务拍板：
 *   · FOR UPDATE 行锁：关掉「删除中途被挂上新子项」的窗口（FK 检查取
 *     FOR KEY SHARE，并发 parent_id=<本行> 阻塞到提交后撞 FK）
 *   · 锚点不可删（reason:"anchor"）；被 report/note/挂载边引用不可删（"mounted"）
 *   · grant/person_manage/entity_link 按内容域键清理
 *   · 子项上移一层（不靠 FK SET NULL——SET NULL 会弹出所在子树，#352）
 *   · 指向本节点的 link 随 FK CASCADE 消亡（原手清 wiki_alias 两条 SQL 退役）
 *
 * asset kind 不走本函数——资产删除入口在 asset 域（deleteAsset），node 壳随
 * FK CASCADE 消亡；这里返回 has_asset 提示调用方走对入口。
 */
export async function deleteNode(
  id: string, productionId: string,
): Promise<DeleteNodeResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ kind: NodeKind; wiki_id: string | null }>(
      `SELECT kind, wiki_id::text AS wiki_id FROM node
       WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [id, productionId],
    );
    if (!locked.rows[0]) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    const { kind, wiki_id: wikiId } = locked.rows[0];
    if (kind === "asset") { await client.query("ROLLBACK"); return { ok: false, reason: "has_asset" }; }

    const anchor = await client.query(
      `SELECT 1 WHERE ${NODE_ANCHOR_EXISTS_SQL("$1::text")}`, [id]);
    if (anchor.rows.length > 0) { await client.query("ROLLBACK"); return { ok: false, reason: "anchor" }; }

    const mounted = await client.query(
      `SELECT 1 FROM event_report WHERE node_id = $1
       UNION ALL
       SELECT 1 FROM event_report_note WHERE node_id = $1
       UNION ALL
       SELECT 1 FROM node_mount WHERE node_id = $1 LIMIT 1`,
      [id],
    );
    if (mounted.rows.length > 0) { await client.query("ROLLBACK"); return { ok: false, reason: "mounted" }; }

    if (wikiId) {
      await client.query(
        `DELETE FROM production_member_grant WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2`,
        [productionId, wikiId],
      );
      await client.query(
        `DELETE FROM resource_person_manage WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2`,
        [productionId, wikiId],
      );
      // entity 侧（别的文档指向本文档）无 FK，主动清零（同 deleteWiki）
      await client.query(
        `DELETE FROM wiki_entity_link WHERE entity_type = 'wiki' AND entity_id = $1`, [wikiId]);
    }
    // 子 link 先行上移，同容器同目标撞唯一约束的就地丢弃（上移后重复的无存在
    // 意义——原 deleteWiki 对 wiki_alias 的同款处理），残留的删除
    await client.query(
      `UPDATE node c SET parent_id = (SELECT parent_id FROM node WHERE id = $1)
       WHERE c.parent_id = $1 AND c.production_id = $2 AND c.kind = 'link'
         AND NOT EXISTS (
           SELECT 1 FROM node b
           WHERE b.parent_id IS NOT DISTINCT FROM (SELECT parent_id FROM node WHERE id = $1)
             AND b.kind = 'link' AND b.link_target_id = c.link_target_id)`,
      [id, productionId],
    );
    await client.query(
      `DELETE FROM node WHERE parent_id = $1 AND production_id = $2 AND kind = 'link'`,
      [id, productionId],
    );
    // 其余子项上移一层
    await client.query(
      `UPDATE node SET parent_id = (SELECT parent_id FROM node WHERE id = $1)
       WHERE parent_id = $1 AND production_id = $2`,
      [id, productionId],
    );
    if (kind === "wiki" && wikiId) {
      // 删内容行 → node 壳随 wiki_id FK CASCADE 消亡；指向本节点的 link 随
      // link_target_id FK CASCADE 消亡
      await client.query(`DELETE FROM wiki WHERE id = $1::uuid AND production_id = $2`, [wikiId, productionId]);
    } else {
      await client.query(`DELETE FROM node WHERE id = $1 AND production_id = $2`, [id, productionId]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  broadcastWikiLibraryChange(productionId, { kind: "deleted", wikiId: id });
  return { ok: true };
}
