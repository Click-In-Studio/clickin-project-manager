import type { PoolClient } from "pg";
import { getPool } from "../pg";
import { keyBetween } from "../lex-order";
import { newNodeId, NODE_ANCHOR_EXISTS_SQL } from "./db";

// ─── 系统锚点（node 根，#420 锚点泛化）───────────────────────────────────────
//
// 三根 + 事件目录：「报告」根、「戏剧构作」（灵感库）根、「资产」根、<event 标题>
// 事件目录。原 wiki 锚点定式逐字延续：
//   · 锚点是**无主公共容器**：INSERT 直建、created_by NULL、不发任何 grant 行，
//     容器写门必须对其豁免（否则默认树谁都放不进东西，#357 症状⑤）
//   · node.is_public=true 防漂根（成员看得见子项看不见祖先 → 树渲染漂根）
//   · 锚认 id 不认位置：可改名可移动，不可删（deleteNode 守卫）
//   · 懒建 + 并发安全：config 行 ON CONFLICT DO NOTHING → FOR UPDATE 串行化；
//     锚被删（FK SET NULL）后自动重建
//   · 锚下任意 kind 合法（PDF asset 进灵感库 = 移动/软链接，落位门只看父不看子）
//
// 报告/灵感库根是 wiki-kind node（锚点是可打开的文档页，UX 不变）；资产根是
// folder-kind node（纯容器）。

export async function isNodeAnchor(nodeId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 WHERE ${NODE_ANCHOR_EXISTS_SQL("$1::text")}`, [nodeId]);
  return rows.length > 0;
}

export type NodeTreeConfig = {
  enabled: boolean;
  rootTitle: string;
  rootNodeId: string | null;
};

/** 「报告」树配置的**只读**读取。渲染/判定路径只准用只读口——ensure* 是带行锁
 *  的写事务且会凭空建节点，必须留在过完门的写路径后面（write-before-authz）。 */
export async function getReportsTreeConfig(productionId: string): Promise<NodeTreeConfig> {
  const res = await getPool().query<{ reports_tree_enabled: boolean; reports_root_title: string; reports_root_node_id: string | null }>(
    `SELECT reports_tree_enabled, reports_root_title, reports_root_node_id
     FROM production_node_config WHERE production_id = $1`,
    [productionId],
  );
  const r = res.rows[0];
  return r
    ? { enabled: r.reports_tree_enabled, rootTitle: r.reports_root_title, rootNodeId: r.reports_root_node_id }
    : { enabled: true, rootTitle: "报告", rootNodeId: null };
}

export async function getDramaturgyTreeConfig(productionId: string): Promise<NodeTreeConfig> {
  const res = await getPool().query<{ dramaturgy_tree_enabled: boolean; dramaturgy_root_title: string; dramaturgy_root_node_id: string | null }>(
    `SELECT dramaturgy_tree_enabled, dramaturgy_root_title, dramaturgy_root_node_id
     FROM production_node_config WHERE production_id = $1`,
    [productionId],
  );
  const r = res.rows[0];
  return r
    ? { enabled: r.dramaturgy_tree_enabled, rootTitle: r.dramaturgy_root_title, rootNodeId: r.dramaturgy_root_node_id }
    : { enabled: true, rootTitle: "戏剧构作", rootNodeId: null };
}

/** 顶层末尾排序键（client 版——ensure 系列在自己的事务里取键）。 */
async function tailRootSortKey(client: PoolClient, productionId: string): Promise<string> {
  const last = await client.query<{ sort_key: string | null }>(
    `SELECT sort_key FROM node
     WHERE production_id = $1 AND parent_id IS NULL AND sort_key IS NOT NULL
     ORDER BY sort_key DESC LIMIT 1`,
    [productionId],
  );
  return keyBetween(last.rows[0]?.sort_key ?? null, null);
}

/** 事务内建「wiki 锚点」＝wiki 内容行 + wiki-kind 壳节点（is_public+listable 写死）。 */
async function insertWikiAnchor(
  client: PoolClient, productionId: string, title: string,
  parentNodeId: string | null, sortKey: string,
): Promise<string> {
  const w = await client.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body) VALUES ($1, $2, '') RETURNING id::text AS id`,
    [productionId, title],
  );
  const nodeId = newNodeId();
  await client.query(
    `INSERT INTO node (id, production_id, kind, parent_id, sort_key, is_public, listable, wiki_id)
     VALUES ($1, $2, 'wiki', $3, $4, true, true, $5::uuid)`,
    [nodeId, productionId, parentNodeId, sortKey, w.rows[0].id],
  );
  return nodeId;
}

/**
 * 懒建报告树锚点（根 + event 目录），返回 event 目录 **node id**；配置关闭时
 * 返回 null。并发/重建语义同旧 ensureReportTreeAnchors（FOR UPDATE 串行化）。
 */
export async function ensureReportTreeAnchors(
  productionId: string,
  eventId: string,
): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO production_node_config (production_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [productionId],
    );
    const cfg = await client.query<{ reports_tree_enabled: boolean; reports_root_title: string; reports_root_node_id: string | null }>(
      `SELECT reports_tree_enabled, reports_root_title, reports_root_node_id
       FROM production_node_config WHERE production_id = $1 FOR UPDATE`,
      [productionId],
    );
    if (!cfg.rows[0]?.reports_tree_enabled) { await client.query("COMMIT"); return null; }

    let rootId = cfg.rows[0].reports_root_node_id;
    if (!rootId) {
      rootId = await insertWikiAnchor(
        client, productionId, cfg.rows[0].reports_root_title, null,
        await tailRootSortKey(client, productionId),
      );
      await client.query(
        `UPDATE production_node_config SET reports_root_node_id = $2, updated_at = now()
         WHERE production_id = $1`,
        [productionId, rootId],
      );
    }

    const ev = await client.query<{ report_doc_node_id: string | null; title: string }>(
      `SELECT report_doc_node_id, title
       FROM production_event WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [eventId, productionId],
    );
    if (!ev.rows[0]) { await client.query("ROLLBACK"); return null; }

    let eventDocId = ev.rows[0].report_doc_node_id;
    if (!eventDocId) {
      const lastChild = await client.query<{ sort_key: string | null }>(
        `SELECT sort_key FROM node
         WHERE parent_id = $1 AND sort_key IS NOT NULL
         ORDER BY sort_key DESC LIMIT 1`,
        [rootId],
      );
      eventDocId = await insertWikiAnchor(
        client, productionId, ev.rows[0].title, rootId,
        keyBetween(lastChild.rows[0]?.sort_key ?? null, null),
      );
      await client.query(
        `UPDATE production_event SET report_doc_node_id = $2 WHERE id = $1`,
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

/** 懒建「戏剧构作」（灵感库）单层系统根，返回根 **node id**；配置关闭返回 null。 */
export async function ensureDramaturgyRootAnchor(productionId: string): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO production_node_config (production_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [productionId],
    );
    const cfg = await client.query<{ dramaturgy_tree_enabled: boolean; dramaturgy_root_title: string; dramaturgy_root_node_id: string | null }>(
      `SELECT dramaturgy_tree_enabled, dramaturgy_root_title, dramaturgy_root_node_id
       FROM production_node_config WHERE production_id = $1 FOR UPDATE`,
      [productionId],
    );
    if (!cfg.rows[0]?.dramaturgy_tree_enabled) { await client.query("COMMIT"); return null; }

    let rootId = cfg.rows[0].dramaturgy_root_node_id;
    if (!rootId) {
      rootId = await insertWikiAnchor(
        client, productionId, cfg.rows[0].dramaturgy_root_title, null,
        await tailRootSortKey(client, productionId),
      );
      await client.query(
        `UPDATE production_node_config SET dramaturgy_root_node_id = $2, updated_at = now()
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

/**
 * 懒建「资产」根（folder-kind），返回根 node id。上传/迁移后的新剧组第一次
 * 创建资产时经此落位。external client＝调用方已在事务里（createAsset）。
 */
export async function ensureAssetsRootAnchor(
  productionId: string, external?: PoolClient,
): Promise<string> {
  const run = async (client: PoolClient): Promise<string> => {
    await client.query(
      `INSERT INTO production_node_config (production_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [productionId],
    );
    const cfg = await client.query<{ assets_root_node_id: string | null }>(
      `SELECT assets_root_node_id FROM production_node_config WHERE production_id = $1 FOR UPDATE`,
      [productionId],
    );
    let rootId = cfg.rows[0]?.assets_root_node_id ?? null;
    if (!rootId) {
      rootId = newNodeId();
      await client.query(
        `INSERT INTO node (id, production_id, kind, parent_id, sort_key, is_public, listable, title)
         VALUES ($1, $2, 'folder', NULL, $3, true, true, '资产')`,
        [rootId, productionId, await tailRootSortKey(client, productionId)],
      );
      await client.query(
        `UPDATE production_node_config SET assets_root_node_id = $2, updated_at = now()
         WHERE production_id = $1`,
        [productionId, rootId],
      );
    }
    return rootId;
  };
  if (external) return run(external);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const id = await run(client);
    await client.query("COMMIT");
    return id;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
