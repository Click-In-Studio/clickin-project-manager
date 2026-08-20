import { getPool } from "./pg";
import { keyBetween } from "./lex-order";
import { writeWikiGrants, WIKI_LEVEL_ROW_SETS, type WikiLevel } from "./resource-grant-db";
import { broadcastWikiLibraryChange } from "./wiki-collab";
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

export type WikiListEntry = Omit<WikiDoc, "body" | "mentions"> & {
  tags: string[];
  /** 系统锚点目录（默认树的根/event 目录）：可移动可改名，不可删除 */
  isAnchor: boolean;
};

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
// code fence / 行内码里的链接语法是"关于语法的文档"不是真引用（MindWeave
// protectCodeSpans 同款教训）——提取前剥除代码上下文
const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

export function extractWikiLinkTargets(body: string): string[] {
  const stripped = body.replace(CODE_SPAN_RE, "");
  const out = new Set<string>();
  for (const m of stripped.matchAll(WIKI_TOKEN_RE)) out.add(m[1].toLowerCase());
  for (const m of stripped.matchAll(WIKI_HREF_RE)) out.add(m[1].toLowerCase());
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
  const res = await getPool().query<WikiRow & { tags: string[] | null; is_anchor: boolean }>(
    `SELECT w.id::text AS id, w.production_id, w.title, w.created_by, w.parent_id::text AS parent_id,
            w.sort_key, w.is_public, w.created_at, w.updated_at, '' AS body, '[]'::jsonb AS mentions,
            array_remove(array_agg(t.tag ORDER BY t.tag), NULL) AS tags,
            (EXISTS (SELECT 1 FROM production_wiki_config c WHERE c.reports_root_wiki_id = w.id)
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

/** 空串 → null（=根目录）。父 id 直接进 $n::uuid，空串会炸成
 *  "invalid input syntax for type uuid"——而"没有父文档"最自然的表达
 *  恰恰是空串，MCP 工具那边模型就这么传（人也一样）。在 db 层收口，
 *  所有写入来源（REST / MCP / 归档管线）一次性受益。 */
function normalizeParentId(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() === "" ? null : (v ?? null);
}

export async function createWiki(params: {
  productionId: string; title: string; body?: string;
  parentId?: string | null; createdBy: string;
  /** revision provenance（如 "ai-proposed"）——默认 writeRevision 自己的 "user"。 */
  origin?: string;
}): Promise<WikiDoc & { tags: string[] }> {
  const parentId = normalizeParentId(params.parentId);
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
  await writeRevision(id, params.title, body, [], params.createdBy, params.origin ?? "user");
  await syncWikiLinks(id, params.productionId, body);
  // 结构变化推给同制作在线的页面（左侧树）——放在 db 层而非各调用处，
  // 是为了让所有写入来源（REST 路由 / MCP 工具 / 报告归档管线）自动同步，
  // 不必每加一个入口就记得补一次广播。无监听者时是纯 no-op。
  broadcastWikiLibraryChange(params.productionId, { kind: "created", wikiId: id });
  return (await getWiki(id, params.productionId))!;
}

export async function updateWiki(
  id: string,
  productionId: string,
  patch: {
    title?: string; body?: string; mentions?: Mention[];
    parentId?: string | null; sortKey?: string; tags?: string[];
    /** 协作：客户端 base 正文——与行内现值不同时在行锁事务内做行级三路合并
     *（AI review：读取-合并-写回不加锁会被并发覆盖，合并保障失效） */
    mergeBase?: string;
    /** revision provenance（如 "ai-proposed"）——默认 writeRevision 自己的 "user"。 */
    origin?: string;
  },
  authorUserId: string,
): Promise<(WikiDoc & { tags: string[] }) | null> {
  const existing = await getWiki(id, productionId);
  if (!existing) return null;

  // 空串按"移到根"处理（同 createWiki，见 normalizeParentId）
  const nextParentId = patch.parentId !== undefined ? normalizeParentId(patch.parentId) : undefined;
  if (nextParentId) {
    if (!await validateParent(productionId, id, nextParentId)) throw new Error("非法的父文档（不存在或成环）");
  }

  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id, productionId];
  const push = (frag: string, v: unknown) => { vals.push(v); sets.push(`${frag}$${vals.length}`); };
  if (patch.title !== undefined) push("title = ", patch.title);
  if (patch.mentions !== undefined) push("mentions = ", JSON.stringify(patch.mentions));
  if (nextParentId !== undefined) push("parent_id = ", nextParentId);
  if (patch.sortKey !== undefined) push("sort_key = ", patch.sortKey);

  if (patch.body !== undefined && patch.mergeBase !== undefined) {
    // 行锁事务内合并写回：SELECT FOR UPDATE 排队并发保存者，各自基于最新现值合并
    const { mergeLines } = await import("./line-merge");
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

  // 结构变化（标题/父/排序/标签）才推库级帧——正文 autosave 每几秒一次，
  // 让它触发全树刷新等于给所有在线页面加一个高频抖动源。
  if (patch.title !== undefined || patch.parentId !== undefined
      || patch.sortKey !== undefined || patch.tags !== undefined) {
    broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId: id });
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

/** 被挂载（report/note 边引用）的 wiki 不可删；系统锚点目录（默认树的根/event
 *  目录）不可删——移动无妨（锚认 id），删除会打散归档并触发重建震荡。
 *  子文档提根由 FK SET NULL 承担。 */
export async function deleteWiki(
  id: string, productionId: string,
): Promise<{ ok: true } | { ok: false; reason: "mounted" | "anchor" | "not_found" }> {
  const pool = getPool();
  const exists = await pool.query(
    `SELECT 1 FROM wiki WHERE id = $1::uuid AND production_id = $2`, [id, productionId]);
  if (!exists.rows[0]) return { ok: false, reason: "not_found" };
  const anchor = await pool.query(
    `SELECT 1 FROM production_wiki_config WHERE reports_root_wiki_id = $1::uuid
     UNION ALL
     SELECT 1 FROM production_event WHERE report_doc_wiki_id = $1::uuid LIMIT 1`,
    [id],
  );
  if (anchor.rows.length > 0) return { ok: false, reason: "anchor" };
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
  // 正开着这篇的人要靠这一帧离场——否则下一次软刷新会撞进 notFound()，
  // 整个人被弹出工程环境（见 WikiDocClient 的 library 监听）。
  broadcastWikiLibraryChange(productionId, { kind: "deleted", wikiId: id });
  return { ok: true };
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

// 个人分享面（grant 行集）——share 路由与 MCP 的 wiki_set_grant 共用这一份实现，
// 别把 production_member_grant 的 SQL 抄第二遍：档位行集口径分叉了就是权限事故。

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
    `SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2::uuid`,
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

/** 出链（该文档链接到谁）——与 listBacklinks 对称，同一张已同步好的 wiki_link 边表。 */
export async function listOutgoingLinks(wikiId: string, productionId: string): Promise<WikiRef[]> {
  const res = await getPool().query<{ id: string; title: string | null }>(
    `SELECT w.id::text AS id, w.title FROM wiki_link l
     JOIN wiki w ON w.id = l.target_wiki_id
     WHERE l.source_wiki_id = $1::uuid AND w.production_id = $2
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
