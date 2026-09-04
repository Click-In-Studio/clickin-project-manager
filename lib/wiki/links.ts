import { getPool } from "../pg";

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
 *  呈现"#[已删除]"。 */
export async function syncWikiLinks(sourceId: string, productionId: string, body: string): Promise<void> {
  const edges = extractMentionEdges(body)
    .filter(e => !(e.entityType === "wiki" && e.entityId === sourceId));
  // 删+插同事务：中途崩溃不留"边被清但没重建"的空窗（review #303-r2-1）
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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
