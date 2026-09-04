import { getPool } from "../pg";
import { writeWikiGrants, WIKI_LEVEL_ROW_SETS, type WikiLevel } from "../resource-grant-db";
import { broadcastWikiLibraryChange } from "./collab";
import type { Mention } from "../event-db";
import { rowToWiki, type WikiDoc, type WikiRow } from "./types";
import { validateParent, tailSortKey, placementSortKey, normalizeParentId, type WikiPlacement } from "./tree";
import { syncWikiLinks } from "./links";

// ─── wiki 内容面（自 wiki-db.ts 拆出，PR-1 纯移动）：CRUD/revision/个人分享行集 ─

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

export async function getWiki(id: string, productionId: string): Promise<(WikiDoc & { tags: string[] }) | null> {
  const res = await getPool().query<WikiRow & { tags: string[] | null }>(
    `SELECT w.id::text AS id, w.production_id, w.title, w.body, w.mentions, w.created_by,
            w.parent_id::text AS parent_id, w.sort_key, w.is_public, w.listable,
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

export async function createWiki(params: {
  productionId: string; title: string; body?: string;
  parentId?: string | null; createdBy: string;
  /** 可枚举性（#357）：缺省 true＝名字随位置进目录；false＝只有显式 meta@view
   *  持有者能在树里列到它，他人须经 wikilink 到达且看不到其子文档。 */
  listable?: boolean;
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
    `INSERT INTO wiki (production_id, title, body, created_by, parent_id, sort_key, listable)
     VALUES ($1, $2, $3, $4, $5::uuid, $6, $7) RETURNING id::text AS id`,
    [params.productionId, params.title, body, params.createdBy, parentId, sortKey,
     params.listable ?? true],
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
    /** 相对锚点落位（#357 症状②）：客户端只说"放在谁的前/后"，键由服务端在
     *  完整兄弟集上算。与 sortKey 二选一，同时给以 place 为准。 */
    place?: WikiPlacement;
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

  // 排序键：相对锚点 > 显式 sortKey > 换父时落尾部（换父不重算会留着旧父的键，
  // 在新兄弟里位置随机——move 菜单的遗留 bug，顺手修）
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
  if (patch.title !== undefined) push("title = ", patch.title);
  if (patch.mentions !== undefined) push("mentions = ", JSON.stringify(patch.mentions));
  if (nextParentId !== undefined) push("parent_id = ", nextParentId);
  if (nextSortKey !== undefined) push("sort_key = ", nextSortKey);

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
 *  子文档不掉顶层，而是上移一层（见函数内注释）。
 *  软链接（#358）**不构成删除阻碍**：指向本篇的别名随删（别名没有内容可丢），
 *  挂在本篇下的别名与子文档同样上移一层——都在同一个事务里。 */
export async function deleteWiki(
  id: string, productionId: string,
): Promise<{ ok: true } | { ok: false; reason: "mounted" | "anchor" | "not_found" }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // 拿住被删行的行锁：这不只是把多条写做成原子，更是关掉「删除中途被挂上新子
    // 文档」的窗口——PG 的 FK 检查会对被引用行取 FOR KEY SHARE，所以并发的
    // INSERT/UPDATE ... parent_id = <本行> 会阻塞到本事务提交，然后撞 FK 失败
    // （createWiki 侧表现为「父文档不存在」）。少了这把锁，那个子文档就会绕过
    // 下面的重挂、被 ON DELETE SET NULL 弹出子树——正是本函数要防的那件事。
    const locked = await client.query(
      `SELECT 1 FROM wiki WHERE id = $1::uuid AND production_id = $2 FOR UPDATE`,
      [id, productionId],
    );
    if (!locked.rows[0]) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }

    const anchor = await client.query(
      `SELECT 1 FROM production_wiki_config
       WHERE reports_root_wiki_id = $1::uuid OR dramaturgy_root_wiki_id = $1::uuid
       UNION ALL
       SELECT 1 FROM production_event WHERE report_doc_wiki_id = $1::uuid LIMIT 1`,
      [id],
    );
    if (anchor.rows.length > 0) { await client.query("ROLLBACK"); return { ok: false, reason: "anchor" }; }

    const mounted = await client.query(
      `SELECT 1 FROM event_report WHERE wiki_id = $1::uuid
       UNION ALL
       SELECT 1 FROM event_report_note WHERE wiki_id = $1::uuid LIMIT 1`,
      [id],
    );
    if (mounted.rows.length > 0) { await client.query("ROLLBACK"); return { ok: false, reason: "mounted" }; }

    await client.query(
      `DELETE FROM production_member_grant WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2`,
      [productionId, id],
    );
    await client.query(
      `DELETE FROM resource_person_manage WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2`,
      [productionId, id],
    );
    // wiki_id 侧的边随 FK CASCADE；entity 侧（别的文档指向本文档）无 FK，
    // 这里顺手清掉。scene/cue 等非 wiki 实体删除时的悬空边是设计内容忍
    // （反向查询只从活宿主页发起），但 wiki 目标的删除入口在自己手里，一行清零。
    await client.query(
      `DELETE FROM wiki_entity_link WHERE entity_type = 'wiki' AND entity_id = $1`, [id]);
    // 指向本篇的软链接一并删（#358）：别名的目标是多态无 FK 的，级联不会自己发生。
    // 不做「失效占位」——那是又一种要设计的 UI 状态，收益为零；读路径另有惰性兜底
    // （解析不到目标的别名不出树），这里是主动清，让库里不留垃圾行。
    await client.query(
      `DELETE FROM wiki_alias WHERE target_type = 'wiki' AND target_id = $1`, [id]);
    // 子文档上移一层，而不是靠 parent_id 的 ON DELETE SET NULL 掉到顶层。SET NULL
    // 会把它们弹出所在子树——在「构作 · 灵感文档」这种只展示某个根子树的工作区
    // 里，那等于当场从视野里消失（得回「文档」模块才找得回来）。
    await client.query(
      `UPDATE wiki SET parent_id = (SELECT parent_id FROM wiki WHERE id = $1::uuid)
       WHERE parent_id = $1::uuid AND production_id = $2`,
      [id, productionId],
    );
    // 挂在本篇下的别名同样上移一层——同一个容器里的子项，处理不能两样
    // （否则别名被 FK SET NULL 弹到顶层，正是上面那条注释要防的事）。
    // 冲突（上一层已有指向同一目标的别名）就地丢弃：唯一约束的语义是「同一容器下
    // 同一目标只一个」，上移后重复的那个没有存在意义。
    await client.query(
      `UPDATE wiki_alias a SET parent_id = (SELECT parent_id FROM wiki WHERE id = $1::uuid)
       WHERE a.parent_id = $1::uuid AND a.production_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM wiki_alias b
           WHERE b.parent_id IS NOT DISTINCT FROM (SELECT parent_id FROM wiki WHERE id = $1::uuid)
             AND b.target_type = a.target_type AND b.target_id = a.target_id)`,
      [id, productionId],
    );
    await client.query(
      `DELETE FROM wiki_alias WHERE parent_id = $1::uuid AND production_id = $2`,
      [id, productionId],
    );
    await client.query(`DELETE FROM wiki WHERE id = $1::uuid AND production_id = $2`, [id, productionId]);
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

export async function setWikiPublic(id: string, productionId: string, isPublic: boolean): Promise<void> {
  await getPool().query(
    `UPDATE wiki SET is_public = $3, updated_at = now() WHERE id = $1::uuid AND production_id = $2`,
    [id, productionId, isPublic],
  );
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
