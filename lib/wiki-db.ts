import { getPool } from "./pg";
import { keyBetween } from "./lex-order";
import { writeWikiGrants } from "./resource-grant-db";
import type { Mention } from "./event-db";

// ─── wiki 文档库 W3：wiki 首次成为一等主体（此前只经 report/note 边消费）────────
//
// 设计账本：MindWeave《wiki文档库-现状调研与实施路线》§4/§5。
// · 树 = 内禀 parent_id + fractional sort_key；树层级不进权限路径
// · 每次内容写入落 wiki_revision（线性历史）；origin 供 AI provenance
// · 正文只存 id 引用（[#wiki:<id>] / /__cm__wiki:<id>），保存时服务端提取进 wiki_link
// · 删除：被挂载（report/note 边引用）的 wiki 不可删——边的生命周期归 W5 统一日

export type WikiDoc = {
  id: string;
  productionId: string;
  title: string | null;
  body: string;
  mentions: Mention[];
  createdBy: string | null;
  parentId: string | null;
  sortKey: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WikiListEntry = Omit<WikiDoc, "body" | "mentions"> & { tags: string[] };

type WikiRow = {
  id: string; production_id: string; title: string | null; body: string;
  mentions: Mention[]; created_by: string | null; parent_id: string | null;
  sort_key: string | null; is_public: boolean; created_at: Date; updated_at: Date;
};

function rowToWiki(r: WikiRow): WikiDoc {
  return {
    id: r.id, productionId: r.production_id, title: r.title, body: r.body,
    mentions: r.mentions ?? [], createdBy: r.created_by, parentId: r.parent_id,
    sortKey: r.sort_key, isPublic: r.is_public,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

// ─── wikilink 提取（两种序列化形态：纯 token 与 markdown 私有 href）────────────

const WIKI_TOKEN_RE = /\[#wiki:([0-9a-fA-F-]{36})\]/g;
const WIKI_HREF_RE = /\(\/__cm__wiki:([0-9a-fA-F-]{36})(?:[?&][^)]*)?\)/g;

export function extractWikiLinkTargets(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKI_TOKEN_RE)) out.add(m[1].toLowerCase());
  for (const m of body.matchAll(WIKI_HREF_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

/** 保存时同步 wiki_link（幻影链接——目标不存在/跨 production——不落行，FK 保证）。 */
async function syncWikiLinks(sourceId: string, productionId: string, body: string): Promise<void> {
  const targets = extractWikiLinkTargets(body).filter(t => t !== sourceId);
  const pool = getPool();
  await pool.query(`DELETE FROM wiki_link WHERE source_wiki_id = $1::uuid`, [sourceId]);
  if (targets.length === 0) return;
  await pool.query(
    `INSERT INTO wiki_link (source_wiki_id, target_wiki_id)
     SELECT $1::uuid, w.id FROM wiki w
     WHERE w.id = ANY($2::uuid[]) AND w.production_id = $3
     ON CONFLICT DO NOTHING`,
    [sourceId, targets, productionId],
  );
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

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** 文档库列表（note 的 wiki 行 title 恒 NULL，不进库面）。可见性过滤由调用方做。 */
export async function listWikiLibrary(productionId: string): Promise<WikiListEntry[]> {
  const res = await getPool().query<WikiRow & { tags: string[] | null }>(
    `SELECT w.id::text AS id, w.production_id, w.title, w.created_by, w.parent_id::text AS parent_id,
            w.sort_key, w.is_public, w.created_at, w.updated_at, '' AS body, '[]'::jsonb AS mentions,
            array_remove(array_agg(t.tag ORDER BY t.tag), NULL) AS tags
     FROM wiki w LEFT JOIN wiki_tag t ON t.wiki_id = w.id
     WHERE w.production_id = $1 AND w.title IS NOT NULL
     GROUP BY w.id
     ORDER BY w.sort_key NULLS LAST, w.created_at`,
    [productionId],
  );
  return res.rows.map(r => {
    const { body: _b, mentions: _m, ...rest } = rowToWiki(r);
    return { ...rest, tags: r.tags ?? [] };
  });
}

export async function getWiki(id: string, productionId: string): Promise<(WikiDoc & { tags: string[] }) | null> {
  const res = await getPool().query<WikiRow & { tags: string[] | null }>(
    `SELECT w.id::text AS id, w.production_id, w.title, w.body, w.mentions, w.created_by,
            w.parent_id::text AS parent_id, w.sort_key, w.is_public, w.created_at, w.updated_at,
            array_remove(array_agg(t.tag ORDER BY t.tag), NULL) AS tags
     FROM wiki w LEFT JOIN wiki_tag t ON t.wiki_id = w.id
     WHERE w.id = $1::uuid AND w.production_id = $2
     GROUP BY w.id`,
    [id, productionId],
  );
  const r = res.rows[0];
  return r ? { ...rowToWiki(r), tags: r.tags ?? [] } : null;
}

async function validateParent(
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

/** 末尾排序键：同层最后一个之后。 */
async function tailSortKey(productionId: string, parentId: string | null): Promise<string> {
  const res = await getPool().query<{ sort_key: string | null }>(
    `SELECT sort_key FROM wiki
     WHERE production_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND sort_key IS NOT NULL
     ORDER BY sort_key DESC LIMIT 1`,
    [productionId, parentId],
  );
  return keyBetween(res.rows[0]?.sort_key ?? null, null);
}

export async function createWiki(params: {
  productionId: string; title: string; body?: string;
  parentId?: string | null; createdBy: string;
}): Promise<WikiDoc & { tags: string[] }> {
  const parentId = params.parentId ?? null;
  if (parentId && !await validateParent(params.productionId, null, parentId)) {
    throw new Error("父文档不存在");
  }
  const sortKey = await tailSortKey(params.productionId, parentId);
  const body = params.body ?? "";
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by, parent_id, sort_key)
     VALUES ($1, $2, $3, $4, $5::uuid, $6) RETURNING id::text AS id`,
    [params.productionId, params.title, body, params.createdBy, parentId, sortKey],
  );
  const id = res.rows[0].id;
  // §0.9 C-6：创建者 manage 行集 + person 归属
  await writeWikiGrants(id, params.productionId, params.createdBy);
  await writeRevision(id, params.title, body, [], params.createdBy);
  await syncWikiLinks(id, params.productionId, body);
  return (await getWiki(id, params.productionId))!;
}

export async function updateWiki(
  id: string,
  productionId: string,
  patch: {
    title?: string; body?: string; mentions?: Mention[];
    parentId?: string | null; sortKey?: string; tags?: string[];
  },
  authorUserId: string,
): Promise<(WikiDoc & { tags: string[] }) | null> {
  const existing = await getWiki(id, productionId);
  if (!existing) return null;

  if (patch.parentId !== undefined && patch.parentId !== null) {
    if (!await validateParent(productionId, id, patch.parentId)) throw new Error("非法的父文档（不存在或成环）");
  }

  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id, productionId];
  const push = (frag: string, v: unknown) => { vals.push(v); sets.push(`${frag}$${vals.length}`); };
  if (patch.title !== undefined) push("title = ", patch.title);
  if (patch.body !== undefined) push("body = ", patch.body);
  if (patch.mentions !== undefined) push("mentions = ", JSON.stringify(patch.mentions));
  if (patch.parentId !== undefined) push("parent_id = ", patch.parentId);
  if (patch.sortKey !== undefined) push("sort_key = ", patch.sortKey);
  await getPool().query(
    `UPDATE wiki SET ${sets.join(", ")} WHERE id = $1::uuid AND production_id = $2`, vals);

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

  // 内容变化才落 revision / 重建链接
  if (patch.title !== undefined || patch.body !== undefined || patch.mentions !== undefined) {
    const next = await getWiki(id, productionId);
    if (next) {
      await writeRevision(id, next.title, next.body, next.mentions, authorUserId);
      if (patch.body !== undefined) await syncWikiLinks(id, productionId, next.body);
    }
  }
  return getWiki(id, productionId);
}

/** 被挂载（report/note 边引用）的 wiki 不可删；子文档提根由 FK SET NULL 承担。 */
export async function deleteWiki(
  id: string, productionId: string,
): Promise<{ ok: true } | { ok: false; reason: "mounted" | "not_found" }> {
  const pool = getPool();
  const exists = await pool.query(
    `SELECT 1 FROM wiki WHERE id = $1::uuid AND production_id = $2`, [id, productionId]);
  if (!exists.rows[0]) return { ok: false, reason: "not_found" };
  const mounted = await pool.query(
    `SELECT 1 FROM event_report WHERE wiki_id = $1::uuid
     UNION ALL
     SELECT 1 FROM event_report_note WHERE wiki_id = $1::uuid LIMIT 1`,
    [id],
  );
  if (mounted.rows.length > 0) return { ok: false, reason: "mounted" };
  await pool.query(
    `DELETE FROM production_member_grant WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2`,
    [productionId, id],
  );
  await pool.query(
    `DELETE FROM resource_person_manage WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2`,
    [productionId, id],
  );
  await pool.query(`DELETE FROM wiki WHERE id = $1::uuid AND production_id = $2`, [id, productionId]);
  return { ok: true };
}

// ─── 分享面 ──────────────────────────────────────────────────────────────────

export async function setWikiPublic(id: string, productionId: string, isPublic: boolean): Promise<void> {
  await getPool().query(
    `UPDATE wiki SET is_public = $3, updated_at = now() WHERE id = $1::uuid AND production_id = $2`,
    [id, productionId, isPublic],
  );
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

// ─── 链接图（标题级列出——§4.1，内容点击处过门）───────────────────────────────

export type WikiRef = { id: string; title: string | null };

export async function listBacklinks(wikiId: string, productionId: string): Promise<WikiRef[]> {
  const res = await getPool().query<{ id: string; title: string | null }>(
    `SELECT w.id::text AS id, w.title FROM wiki_link l
     JOIN wiki w ON w.id = l.source_wiki_id
     WHERE l.target_wiki_id = $1::uuid AND w.production_id = $2
     ORDER BY w.updated_at DESC`,
    [wikiId, productionId],
  );
  return res.rows;
}

/** unlinked references：正文含目标标题但无链接边的文档（pg_trgm 加速的 ILIKE）。 */
export async function listUnlinkedReferences(wikiId: string, productionId: string): Promise<WikiRef[]> {
  const target = await getPool().query<{ title: string | null }>(
    `SELECT title FROM wiki WHERE id = $1::uuid AND production_id = $2`, [wikiId, productionId]);
  const title = target.rows[0]?.title?.trim();
  if (!title) return [];
  const res = await getPool().query<{ id: string; title: string | null }>(
    `SELECT w.id::text AS id, w.title FROM wiki w
     WHERE w.production_id = $1 AND w.id <> $2::uuid
       AND w.body ILIKE '%' || $3 || '%'
       AND NOT EXISTS (SELECT 1 FROM wiki_link l
                       WHERE l.source_wiki_id = w.id AND l.target_wiki_id = $2::uuid)
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
