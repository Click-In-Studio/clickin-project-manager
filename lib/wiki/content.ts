import type { PoolClient } from "pg";
import { getPool } from "../pg";
import { writeWikiGrants, WIKI_LEVEL_ROW_SETS, type WikiLevel } from "../resource-grant-db";
import { broadcastWikiLibraryChange } from "./collab";
import type { Mention } from "../event-db";
import { rowToWiki, type WikiDoc, type WikiRow } from "./types";
import { syncWikiLinks } from "./links";
import {
  insertNode, deleteNode, getNodeByWikiId, normalizeParentId, validateParent,
  tailSortKey, placementSortKey, type NodePlacement, type DeleteNodeResult,
} from "../node/db";

// ─── wiki 内容面（#420 后）：CRUD / revision / 个人分享行集 ──────────────────
//
// wiki 是纯内容对象；树位置与权限位在 node 壳上。创建=内容行+壳节点**同事务**
// （1:1 不变量不许有窗口）；删除入口在 node 域（deleteNode），此处只留转发。

export async function getWiki(id: string, productionId: string): Promise<(WikiDoc & { tags: string[] }) | null> {
  const res = await getPool().query<WikiRow & { tags: string[] | null }>(
    `SELECT w.id::text AS id, w.production_id, w.title, w.body, w.mentions, w.created_by,
            w.created_at, w.updated_at,
            array_remove(array_agg(t.tag ORDER BY t.tag), NULL) AS tags
     FROM wiki w LEFT JOIN wiki_tag t ON t.wiki_id = w.id
     WHERE w.id = $1::uuid AND w.production_id = $2
     GROUP BY w.id`,
    [id, productionId],
  );
  const r = res.rows[0];
  return r ? { ...rowToWiki(r), tags: r.tags ?? [] } : null;
}

async function writeRevision(
  wikiId: string, title: string | null, body: string, mentions: Mention[],
  authorUserId: string | null, origin = "user",
): Promise<void> {
  await getPool().query(
    `INSERT INTO wiki_revision (wiki_id, title, body, mentions, author_user_id, origin)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [wikiId, title, body, JSON.stringify(mentions), authorUserId, origin],
  );
}

export async function createWiki(params: {
  productionId: string; title: string; body?: string;
  /** 壳节点的父（node id）。 */
  parentNodeId?: string | null;
  place?: NodePlacement;
  createdBy: string;
  /** 可枚举性（#357）：缺省 true＝名字随位置进目录。挂在 node 壳上。 */
  listable?: boolean;
  /** revision provenance（如 "ai-proposed"）。 */
  origin?: string;
  /** 调用方已在事务里（报告归档管线）：内容行+壳节点写进它的事务。 */
  external?: PoolClient;
}): Promise<WikiDoc & { tags: string[]; nodeId: string }> {
  const parentNodeId = normalizeParentId(params.parentNodeId);
  if (parentNodeId && !await validateParent(params.productionId, null, parentNodeId)) {
    throw new Error("父节点不存在或不可作容器");
  }
  const sortKey = params.place
    ? await placementSortKey(params.productionId, parentNodeId, params.place, null)
    : await tailSortKey(params.productionId, parentNodeId);
  const body = params.body ?? "";

  const write = async (client: PoolClient): Promise<{ id: string; nodeId: string }> => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO wiki (production_id, title, body, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [params.productionId, params.title, body, params.createdBy],
    );
    const id = res.rows[0].id;
    const nodeId = await insertNode({
      productionId: params.productionId, kind: "wiki",
      parentId: parentNodeId, sortKey, wikiId: id,
      listable: params.listable ?? true, createdBy: params.createdBy,
    }, client);
    return { id, nodeId };
  };

  let created: { id: string; nodeId: string };
  if (params.external) {
    created = await write(params.external);
  } else {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      created = await write(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  // §0.9 C-6：创建者 manage 行集 + person 归属
  await writeWikiGrants(created.id, params.productionId, params.createdBy);
  await writeRevision(created.id, params.title, body, [], params.createdBy, params.origin ?? "user");
  await syncWikiLinks(created.id, params.productionId, body);
  // 结构变化推给同制作在线页面——放 db 层让所有写入来源自动同步
  broadcastWikiLibraryChange(params.productionId, { kind: "created", wikiId: created.nodeId });
  return { ...(await getWiki(created.id, params.productionId))!, nodeId: created.nodeId };
}

export async function updateWiki(
  id: string,
  productionId: string,
  patch: {
    title?: string; body?: string; mentions?: Mention[]; tags?: string[];
    /** 协作：客户端 base 正文——与行内现值不同时在行锁事务内做行级三路合并 */
    mergeBase?: string;
    origin?: string;
  },
  authorUserId: string,
): Promise<(WikiDoc & { tags: string[] }) | null> {
  const existing = await getWiki(id, productionId);
  if (!existing) return null;

  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id, productionId];
  const push = (frag: string, v: unknown) => { vals.push(v); sets.push(`${frag}$${vals.length}`); };
  if (patch.title !== undefined) push("title = ", patch.title);
  if (patch.mentions !== undefined) push("mentions = ", JSON.stringify(patch.mentions));

  if (patch.body !== undefined && patch.mergeBase !== undefined) {
    // 行锁事务内合并写回：SELECT FOR UPDATE 排队并发保存者，各自基于最新现值合并
    const { mergeLines } = await import("../line-merge");
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query<{ body: string }>(
        `SELECT body FROM wiki WHERE id = $1::uuid AND production_id = $2 FOR UPDATE`,
        [id, productionId]);
      if (!cur.rows[0]) { await client.query("ROLLBACK"); return null; }
      const current = cur.rows[0].body;
      const merged = current === patch.mergeBase
        ? patch.body
        : mergeLines(patch.mergeBase, patch.body, current);
      vals.push(merged); sets.push(`body = $${vals.length}`);
      await client.query(
        `UPDATE wiki SET ${sets.join(", ")} WHERE id = $1::uuid AND production_id = $2`, vals);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    if (patch.body !== undefined) push("body = ", patch.body);
    await getPool().query(
      `UPDATE wiki SET ${sets.join(", ")} WHERE id = $1::uuid AND production_id = $2`, vals);
  }

  if (patch.tags !== undefined) {
    const tags = [...new Set(patch.tags.map(t => t.trim()).filter(Boolean))];
    await getPool().query(`DELETE FROM wiki_tag WHERE wiki_id = $1::uuid`, [id]);
    if (tags.length > 0) {
      await getPool().query(
        `INSERT INTO wiki_tag (wiki_id, tag) SELECT $1::uuid, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [id, tags],
      );
    }
  }

  // 结构性内容变化（标题/标签）才推库级帧——正文 autosave 不触发全树刷新
  if (patch.title !== undefined || patch.tags !== undefined) {
    const node = await getNodeByWikiId(id);
    broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId: node?.id ?? id });
  }

  // 内容变化才落 revision / 重建链接
  if (patch.title !== undefined || patch.body !== undefined || patch.mentions !== undefined) {
    const next = await getWiki(id, productionId);
    if (next) {
      await writeRevision(id, next.title, next.body, next.mentions, authorUserId, patch.origin ?? "user");
      if (patch.body !== undefined) await syncWikiLinks(id, productionId, next.body);
    }
  }
  return getWiki(id, productionId);
}

/** 删除转发：删 wiki＝删它的壳节点（守卫/子项上移/级联全在 deleteNode）。 */
export async function deleteWiki(
  id: string, productionId: string,
): Promise<DeleteNodeResult> {
  const node = await getNodeByWikiId(id);
  if (!node || node.productionId !== productionId) return { ok: false, reason: "not_found" };
  return deleteNode(node.id, productionId);
}

// ─── 个人分享面（grant 行集）——share 路由与 MCP 的 wiki_set_grant 共用这一份，
// 档位行集口径分叉了就是权限事故。键在内容域（'wiki'/uuid），#420 不迁。

export type WikiSharePerson = { userId: string; level: WikiLevel };

/** 反推分享档：grants@edit → manage，*@edit → edit，否则 view（与 WIKI_LEVEL_ROW_SETS 对偶）。 */
export async function listWikiSharePeople(wikiId: string, productionId: string): Promise<WikiSharePerson[]> {
  const res = await getPool().query<{ user_id: string; subs: string[] }>(
    `SELECT user_id::text AS user_id, array_agg(resource_sub || '@' || permission_level) AS subs
     FROM production_member_grant
     WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2
       AND NOT is_revoked AND (expires_at IS NULL OR expires_at > NOW())
     GROUP BY user_id`,
    [productionId, wikiId],
  );
  return res.rows.map(r => ({
    userId: r.user_id,
    level: (r.subs.includes("grants@edit") ? "manage" : r.subs.includes("*@edit") ? "edit" : "view") as WikiLevel,
  }));
}

/** 发行个人分享行集。对方不是本项目成员 → 不发行任何行（分享面不越过成员门）。 */
export async function addWikiSharePerson(
  wikiId: string, productionId: string,
  args: { userId: string; level: WikiLevel; confirmedBy: string },
): Promise<"ok" | "not_member" | "invalid_level"> {
  const rows = WIKI_LEVEL_ROW_SETS[args.level];
  if (!rows) return "invalid_level";
  const pool = getPool();
  const member = await pool.query(
    `SELECT 1 FROM production_member
      WHERE production_id = $1 AND user_id = $2::uuid AND status = 'active'`,
    [productionId, args.userId],
  );
  if (!member.rows[0]) return "not_member";
  for (const [sub, verb] of rows) {
    await pool.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2::uuid, 'wiki', $3, $4, $5, 'direct', $6::uuid)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, args.userId, wikiId, sub, verb, args.confirmedBy],
    );
  }
  return "ok";
}

/** 撤销某人在这篇文档上的全部个人分享行（结构面的部门/公开分享不受影响）。 */
export async function removeWikiSharePerson(
  wikiId: string, productionId: string, userId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE production_member_grant
     SET is_revoked = true, revoked_reason = 'manual'
     WHERE production_id = $1 AND user_id = $2::uuid
       AND resource_type = 'wiki' AND resource_id = $3 AND NOT is_revoked`,
    [productionId, userId, wikiId],
  );
}
