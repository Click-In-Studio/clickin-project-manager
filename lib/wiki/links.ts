import { getPool } from "../pg";
import { canPublishAsset } from "../asset/perm";
import { uid } from "../asset/db";
import type { GrantActor } from "../grant-check";
import { isWikiId } from "./id";

// ─── mention 边提取（两种序列化形态：纯 token 与 markdown 私有 href）───────────

// 落边的 kind 全集：ContentMentionKind 去掉 page（页码不是实体）。
// 锚定语义逐字继承 mention 体系：全 kind 一律锚**稳定 id**，不锚修订行 id。
// cue 曾是唯一的例外（锚 cue.id 行 id），#302 已随 migrate-cue-mention-stable-id
// 与 mention 体系同批切到 cue.cue_id——边表与正文不允许锚不同的 id。
const EDGE_KINDS = new Set(["wiki", "scene", "rehearsal", "block", "cue", "asset"]);

export type MentionEdge = { entityType: string; entityId: string };

// 现行引用 URI：/__cm__/<type>/<id>[?params][#anchor]——id 截到 )?#& 为止，
// params（v/as/aux）与 anchor 都不属于实体身份，剥除。type=user 不落边
// （EDGE_KINDS 过滤），@提及的关系走 wiki.mentions 列。
const CM_HREF_RE = /\(\/__cm__\/([a-z]+)\/([^)?#&\s]+)/g;
// ── 以下两条是**只读兼容**：wiki.body 已由 migrate-wiki-dialect-v2 全量迁移，
// 但 wiki_revision 的历史正文不迁移（历史就该是历史），回滚场景亦需兜底。
// 旧式裸 token（W1 时期废弃）只存在过 wiki 一种 kind
const WIKI_TOKEN_RE = /\[#wiki:([0-9a-fA-F-]{36})\]/g;
// 旧式私有 href：/__cm__<kind>:<id>[?v=..][:aux]
const CM_HREF_LEGACY_RE = /\(\/__cm__([a-z_.]+):([^):?&\s]+)/g;
// code fence / 行内码里的链接语法是"关于语法的文档"不是真引用（MindWeave
// protectCodeSpans 同款教训）——提取前剥除代码上下文
const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/** 正文 → 引用边（全 kind；block.<mode> 归一为 block，wiki id 归一小写）。 */
export function extractMentionEdges(body: string): MentionEdge[] {
  const stripped = body.replace(CODE_SPAN_RE, "");
  const seen = new Set<string>();
  const out: MentionEdge[] = [];
  const add = (entityType: string, entityId: string) => {
    const key = `${entityType} ${entityId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ entityType, entityId });
  };
  for (const m of stripped.matchAll(CM_HREF_RE)) {
    if (!EDGE_KINDS.has(m[1])) continue;
    add(m[1], m[1] === "wiki" ? m[2].toLowerCase() : m[2]);
  }
  // 只读兼容（历史正文/回滚）
  for (const m of stripped.matchAll(WIKI_TOKEN_RE)) add("wiki", m[1].toLowerCase());
  for (const m of stripped.matchAll(CM_HREF_LEGACY_RE)) {
    const kind = m[1].startsWith("block.") ? "block" : m[1];
    if (!EDGE_KINDS.has(kind)) continue;
    add(kind, kind === "wiki" ? m[2].toLowerCase() : m[2]);
  }
  return out;
}

// 嵌入形态（引用类加 `!` 前缀，语法大纲 §3）：![alt](/__cm__/asset/<id>)。
// 与 CM_HREF_RE 的差别只在 `!\[…\]` 前缀——嵌入除了落引用边，还要派生 embed
// 挂载边（「文档可见 ⇒ 正文里的图可见」的让渡通道），所以要单独认出来。
const EMBED_ASSET_RE = /!\[[^\]\n]*\]\(\/__cm__\/asset\/([^)?#&\s]+)/g;
// v1 冒号形态只读兼容（wiki_revision 历史正文不迁移，回滚场景兜底）
const EMBED_ASSET_LEGACY_RE = /!\[[^\]\n]*\]\(\/__cm__asset:([^):?&\s]+)/g;

/** 正文 → 嵌入的 asset id 集合（代码上下文剥除，与 extractMentionEdges 同规）。 */
export function extractEmbedAssetIds(body: string): string[] {
  const stripped = body.replace(CODE_SPAN_RE, "");
  const seen = new Set<string>();
  for (const m of stripped.matchAll(EMBED_ASSET_RE)) seen.add(m[1]);
  for (const m of stripped.matchAll(EMBED_ASSET_LEGACY_RE)) seen.add(m[1]);
  return [...seen];
}

/** 兼容旧签名：正文中的 wiki 目标 id 列表（MCP 侧幻影目标替换仍在用）。 */
export function extractWikiLinkTargets(body: string): string[] {
  return extractMentionEdges(body)
    .filter(e => e.entityType === "wiki")
    .map(e => e.entityId);
}

/** 保存时重建派生边。只清 origin='wiki_body'——manual 边（Phase 2 显式建链）
 *  不属于正文，重建不得触碰。派生边不做存在性校验直接落行：幻影/跨 production
 *  的边永远不会被渲染（反向查询按 production_id 过滤且只从活宿主页发起，
 *  wiki 侧读取处 join wiki 表过滤），正文里的死引用由 mention-resolve
 *  呈现"#[已删除]"。
 *
 *  embed 挂载边（「文档可见 ⇒ 正文里的图可见」的让渡通道）同批派生：正文是
 *  唯一真相，嵌入了就有边、删掉了就回收——原先由编辑器插图时"尽力而为"补打
 *  mounts API，插入路径一多（粘贴/拖拽/AI 写入）就是乘法增长的漏挂面。
 *  新增边过 asset 侧 publication@create 门（与 mounts API 双门同源）：把别人
 *  asset 的嵌入 URI 抄进正文不构成让渡，图对无票观看者保持不可见；host 侧门
 *  （编辑本文档）由写路径本身已过。回收不设门——嵌入即让渡、移除即收回。 */
export async function syncWikiLinks(
  sourceId: string, productionId: string, body: string, authorUserId: string,
): Promise<void> {
  const edges = extractMentionEdges(body)
    .filter(e => !(e.entityType === "wiki" && e.entityId === sourceId));
  const embedIds = new Set(extractEmbedAssetIds(body));
  const pool = getPool();

  // 删+插同事务：中途崩溃不留"边被清但没重建"的空窗（review #303-r2-1）
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 宿主行锁串行化同一篇的并发 reconcile（AI review #448-1：READ COMMITTED
    // 下裸 NOT EXISTS 挡不住双事务同过存在性检查——node_mount 无唯一约束，
    // 双插会真落两行）。embed 边唯一写入方就是本函数（两条 mounts 路由拒收
    // 直写），锁住 wiki 行即锁住全部写入序；读侧快照也因此不再陈旧。
    await client.query(`SELECT 1 FROM wiki WHERE id = $1::uuid FOR UPDATE`, [sourceId]);

    const current = (await client.query<{ id: string; asset_id: string }>(
      `SELECT nm.id, n.asset_id FROM node_mount nm
       JOIN node n ON n.id = nm.node_id
       WHERE nm.production_id = $1 AND nm.mount_type = 'embed' AND nm.mount_id = $2
         AND n.asset_id IS NOT NULL`,
      [productionId, sourceId],
    )).rows;
    const currentAssets = new Set(current.map(r => r.asset_id));
    const staleMountIds = current.filter(r => !embedIds.has(r.asset_id)).map(r => r.id);
    const candidateIds = [...embedIds].filter(a => !currentAssets.has(a));

    // 门检查走各自的连接读已提交数据，持锁窗口内的几次点查，代价可接受
    let grantedAdds: string[] = [];
    if (candidateIds.length > 0) {
      // owner 旁路要真 owner 位（isAdmin 是死字段恒 false，见 PR #281 事故）
      const owner = await client.query<{ owner_id: string | null }>(
        `SELECT owner_id FROM production WHERE id = $1`, [productionId]);
      const actor: GrantActor = {
        userId: authorUserId, isAdmin: false,
        isOwner: owner.rows[0]?.owner_id === authorUserId,
      };
      const results = await Promise.all(candidateIds.map(a =>
        canPublishAsset(actor, productionId, a, "create")));
      grantedAdds = candidateIds.filter((_, i) => results[i]);
    }

    await client.query(
      `DELETE FROM wiki_entity_link WHERE wiki_id = $1::uuid AND origin = 'wiki_body'`,
      [sourceId],
    );
    if (edges.length > 0) {
      await client.query(
        `INSERT INTO wiki_entity_link (wiki_id, production_id, entity_type, entity_id, origin)
         SELECT $1::uuid, $2, t, i, 'wiki_body' FROM unnest($3::text[], $4::text[]) AS u(t, i)
         ON CONFLICT DO NOTHING`,
        [sourceId, productionId, edges.map(e => e.entityType), edges.map(e => e.entityId)],
      );
    }
    if (staleMountIds.length > 0) {
      await client.query(`DELETE FROM node_mount WHERE id = ANY($1::text[])`, [staleMountIds]);
    }
    for (const assetId of grantedAdds) {
      // NOT EXISTS 不是并发防线（那是上面行锁的职责），只兜历史存量：老前端
      // 管道可能留下的重复 embed 行别再叠一层。壳节点缺失（1:1 不变量破损）
      // 则静默不落——与 canViewAsset 的无壳分支同口径。
      await client.query(
        `INSERT INTO node_mount (id, node_id, production_id, mount_type, mount_id, created_by)
         SELECT $1, n.id, $2, 'embed', $3, $4::uuid FROM node n
         WHERE n.asset_id = $5 AND n.production_id = $2
           AND NOT EXISTS (SELECT 1 FROM node_mount x
                           WHERE x.node_id = n.id AND x.mount_type = 'embed' AND x.mount_id = $3)`,
        [uid("am"), productionId, sourceId, authorUserId, assetId],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── 链接图（标题级列出——§4.1，内容点击处过门）───────────────────────────────

export type WikiRef = { id: string; title: string | null };

export async function listBacklinks(wikiId: string, productionId: string): Promise<WikiRef[]> {
  // DISTINCT：同一来源可能同时有 body 边与 manual 边（PK 含 origin）
  const res = await getPool().query<{ id: string; title: string | null }>(
    `SELECT DISTINCT w.id::text AS id, w.title, w.updated_at FROM wiki_entity_link l
     JOIN wiki w ON w.id = l.wiki_id
     WHERE l.entity_type = 'wiki' AND l.entity_id = $1 AND w.production_id = $2
     ORDER BY w.updated_at DESC`,
    [wikiId.toLowerCase(), productionId],
  );
  return res.rows.map(r => ({ id: r.id, title: r.title }));
}

/** 出链（该文档链接到谁）——与 listBacklinks 对称，同一张已同步好的边表。
 *  join 用 w.id::text（entity_id 无类型，uuid cast 遇脏行会整查询炸掉）。 */
export async function listOutgoingLinks(wikiId: string, productionId: string): Promise<WikiRef[]> {
  if (!isWikiId(wikiId)) return [];
  const res = await getPool().query<{ id: string; title: string | null }>(
    `SELECT DISTINCT w.id::text AS id, w.title, w.updated_at FROM wiki_entity_link l
     JOIN wiki w ON w.id::text = l.entity_id
     WHERE l.wiki_id = $1::uuid AND l.entity_type = 'wiki' AND w.production_id = $2
     ORDER BY w.updated_at DESC`,
    [wikiId, productionId],
  );
  return res.rows.map(r => ({ id: r.id, title: r.title }));
}

export type EntityWikiRef = WikiRef & {
  /** 存在 origin='manual' 行（UI 据此暴露解除入口；body 边只能改正文） */
  manual: boolean;
};

/** 对象侧反向面板：引用了该实体的 wiki（标题级列出——§4.1，不过滤 wiki 可见性，
 *  点击处由 wiki 页过门+申请）。production_id 过滤兼防跨剧组 mention 泄漏。 */
export async function listWikiRefsForEntity(
  productionId: string, entityType: string, entityId: string,
): Promise<EntityWikiRef[]> {
  const res = await getPool().query<{ id: string; title: string | null; manual: boolean }>(
    `SELECT w.id::text AS id, w.title, bool_or(l.origin = 'manual') AS manual
     FROM wiki_entity_link l
     JOIN wiki w ON w.id = l.wiki_id
     WHERE l.production_id = $1 AND l.entity_type = $2 AND l.entity_id = $3
     GROUP BY w.id, w.title, w.updated_at
     ORDER BY w.updated_at DESC LIMIT 50`,
    [productionId, entityType, entityId],
  );
  return res.rows.map(r => ({ id: r.id, title: r.title, manual: r.manual }));
}

export type WikiEntityRef = { entityType: string; entityId: string; manual: boolean };

/** wiki 侧"关联对象"面板：本文的非 wiki 出边（body+manual 合并；wiki↔wiki
 *  已有 backlinks/正文 chip 承载）。标签由调用方经 mention-resolve 逐观看者解析。 */
export async function listEntityRefsForWiki(
  wikiId: string, productionId: string,
): Promise<WikiEntityRef[]> {
  if (!isWikiId(wikiId)) return [];
  const res = await getPool().query<{ entity_type: string; entity_id: string; manual: boolean }>(
    `SELECT entity_type, entity_id, bool_or(origin = 'manual') AS manual
     FROM wiki_entity_link
     WHERE wiki_id = $1::uuid AND production_id = $2 AND entity_type <> 'wiki'
     GROUP BY entity_type, entity_id
     ORDER BY entity_type, entity_id LIMIT 100`,
    [wikiId, productionId],
  );
  return res.rows.map(r => ({ entityType: r.entity_type, entityId: r.entity_id, manual: r.manual }));
}

/** 显式建链（origin='manual'，Phase 2）。wiki 归属校验内含：跨 production 不落行。
 *  重复建链幂等（PK 冲突吞掉）。返回是否落行/已存在。 */
export async function addManualWikiEntityLink(params: {
  wikiId: string; productionId: string; entityType: string; entityId: string; createdBy: string;
}): Promise<boolean> {
  const res = await getPool().query(
    `INSERT INTO wiki_entity_link (wiki_id, production_id, entity_type, entity_id, origin, created_by)
     SELECT w.id, w.production_id, $3, $4, 'manual', $5::uuid
     FROM wiki w WHERE w.id = $1::uuid AND w.production_id = $2
     ON CONFLICT DO NOTHING`,
    [params.wikiId, params.productionId, params.entityType, params.entityId, params.createdBy],
  );
  if (res.rowCount && res.rowCount > 0) return true;
  const exists = await getPool().query(
    `SELECT 1 FROM wiki_entity_link
     WHERE wiki_id = $1::uuid AND production_id = $2 AND entity_type = $3 AND entity_id = $4 AND origin = 'manual'`,
    [params.wikiId, params.productionId, params.entityType, params.entityId],
  );
  return exists.rows.length > 0;
}

/** 解除显式建链。只删 manual 行——body 边归正文管理，面板不得越权抹。 */
export async function removeManualWikiEntityLink(
  wikiId: string, productionId: string, entityType: string, entityId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM wiki_entity_link
     WHERE wiki_id = $1::uuid AND production_id = $2 AND entity_type = $3 AND entity_id = $4 AND origin = 'manual'`,
    [wikiId, productionId, entityType, entityId],
  );
}

/** unlinked references：正文含目标标题但无链接边的文档（pg_trgm 加速的 ILIKE）。 */
export async function listUnlinkedReferences(wikiId: string, productionId: string): Promise<WikiRef[]> {
  if (!isWikiId(wikiId)) return [];
  const target = await getPool().query<{ title: string | null }>(
    `SELECT title FROM wiki WHERE id = $1::uuid AND production_id = $2`, [wikiId, productionId]);
  const title = target.rows[0]?.title?.trim();
  if (!title) return [];
  const res = await getPool().query<{ id: string; title: string | null }>(
    `SELECT w.id::text AS id, w.title FROM wiki w
     WHERE w.production_id = $1 AND w.id::text <> $2
       AND w.body ILIKE '%' || $3 || '%'
       AND NOT EXISTS (SELECT 1 FROM wiki_entity_link l
                       WHERE l.wiki_id = w.id AND l.entity_type = 'wiki' AND l.entity_id = $2)
     ORDER BY w.updated_at DESC LIMIT 50`,
    [productionId, wikiId, title],
  );
  return res.rows;
}

export async function searchWiki(productionId: string, q: string): Promise<WikiRef[]> {
  const needle = q.trim();
  if (!needle) return [];
  const res = await getPool().query<{ id: string; title: string | null }>(
    `SELECT id::text AS id, title FROM wiki
     WHERE production_id = $1 AND title IS NOT NULL
       AND (title ILIKE '%' || $2 || '%' OR body ILIKE '%' || $2 || '%')
     ORDER BY updated_at DESC LIMIT 50`,
    [productionId, needle],
  );
  return res.rows;
}
