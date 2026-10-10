import { getPool } from "../pg";
import type { GrantActor } from "../perm/grant-check";
import { isWikiId } from "./id";
import { listVisibleWikiIds } from "./perm";
import type { WikiPersonalNavigation, WikiRecentVisit } from "./personal-navigation-types";

/** 只查目标身份与项目归属，访问记录不需要读取整篇正文。 */
export async function wikiVisitTargetExists(productionId: string, wikiId: string): Promise<boolean> {
  if (!isWikiId(wikiId)) return false;
  const result = await getPool().query(
    `SELECT 1 FROM wiki WHERE id = $1::uuid AND production_id = $2`, [wikiId, productionId],
  );
  return result.rows.length > 0;
}

/** 调用方先过正文阅读门。记录一次即结束；不排队、不补报、不重试。 */
export async function recordWikiVisit(userId: string, productionId: string, wikiId: string): Promise<void> {
  const id = `wrv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await getPool().query(
    `INSERT INTO wiki_recent_visit (id, user_id, production_id, wiki_id, last_viewed_at)
     VALUES ($1, $2, $3, $4::uuid, statement_timestamp())
     ON CONFLICT (user_id, production_id, wiki_id) DO UPDATE
     SET last_viewed_at = GREATEST(wiki_recent_visit.last_viewed_at, EXCLUDED.last_viewed_at)`,
    [id, userId, productionId, wikiId],
  );
}

type Candidate = {
  wiki_id: string; title: string | null; last_viewed_at: Date; cursor_time: string;
};

/** 按索引分批过内容门，找到 20 篇可读文档再停止；撤权历史不会挤掉旧可读项。 */
export async function getWikiPersonalNavigation(
  actor: GrantActor, productionId: string,
): Promise<WikiPersonalNavigation> {
  const recent: WikiRecentVisit[] = [];
  let cursor: Candidate | undefined;
  const batchSize = 100;
  while (recent.length < 20) {
    const { rows } = await getPool().query<Candidate>(
      `SELECT v.wiki_id::text, w.title, v.last_viewed_at, v.last_viewed_at::text AS cursor_time
       FROM wiki_recent_visit v JOIN wiki w ON w.id = v.wiki_id AND w.production_id = v.production_id
       WHERE v.user_id = $1 AND v.production_id = $2
         ${cursor ? "AND (v.last_viewed_at, v.wiki_id) < ($3::timestamptz, $4::uuid)" : ""}
       ORDER BY v.last_viewed_at DESC, v.wiki_id DESC LIMIT ${batchSize}`,
      cursor ? [actor.userId, productionId, cursor.cursor_time, cursor.wiki_id] : [actor.userId, productionId],
    );
    if (rows.length === 0) break;
    const visible = await listVisibleWikiIds(actor, productionId, rows.map(row => row.wiki_id));
    for (const row of rows) {
      if (visible.wildcard || visible.ids.has(row.wiki_id)) {
        recent.push({ wikiId: row.wiki_id, title: row.title, lastViewedAt: row.last_viewed_at.toISOString() });
        if (recent.length === 20) break;
      }
    }
    if (rows.length < batchSize) break;
    // SQL 原始时间保留微秒精度；不能用转换成毫秒的 JSON 时间作分页游标。
    cursor = rows[rows.length - 1];
  }
  return { pinned: [], recent };
}
