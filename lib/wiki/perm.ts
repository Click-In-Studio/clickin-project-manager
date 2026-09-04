import { getPool } from "../pg";
import { isPolicyOn } from "../policy-db";
import { hasGrant, listGrantedResourceIds, type GrantActor } from "../grant-check";
import { hasEventDomainView } from "../event-permissions";
import { mountConcededNodeIds } from "../node/host-visibility";

// ─── wiki 文档库 W3：可见性判定（账本 §4.2，asset 隐私模型同构）─────────────────
//
// 可见(user, wiki) = 个人 grant 行（创建者行集 / grants@edit 持有者分享）
//                  ∨ is_public（全体，结构面）
//                  ∨ dept 分享面（wiki_dept_share ∩ 用户部门，判定时查成员零 sweep）
//                  ∨ ∃挂载边: 宿主可见（report 边→报告可见性；note 边→其 report 可见性；
//                    scene/block/cue/event 挂载边→lib/node/host-visibility 共享核，
//                    与 asset 挂载让渡同源——#420 第二批拍板）
//
// 挂载/分享面永不物化 grant 行（§0.9 负面清单）；解除挂载/分享即收缩。
// 标题=目录级信息沿引用边流出（§4.1），由 mention-resolve 承担，不经本判定。
//
// 【两个面，别混】（#357）——本段是**内容面**：能不能读这篇。
// 目录树用的是**枚举面**（本文件下半 listEnumerableWikiIds）：能不能在目录里列到它。
// 名字沿引用边逐点流出 ≠ 名字集合可枚举，两者是不同的披露类，不得互相推导。
// 不变量：枚举面的任何变化不得改变 canViewWiki 的判定结果。

type WikiVisibilityRow = { id: string; is_public: boolean; node_id: string | null };

/** report 边的宿主可见判据（对齐 reports/[reportId]/page.tsx 的门）：
 *  已发布 ∧ 事件域 view；或 draft 四通道（report 实例行 / publication@view /
 *  event reports@view / 部门参与者）。 */
async function reportEdgeVisible(
  actor: GrantActor,
  productionId: string,
  edge: { reportId: string; eventId: string; published: boolean },
): Promise<boolean> {
  if (edge.published && await hasEventDomainView(actor, productionId)) return true;
  if (await hasGrant(actor.userId, productionId, "report", edge.reportId, "meta", "view")) return true;
  if (await hasGrant(actor.userId, productionId, "report", edge.reportId, "publication", "view")) return true;
  if (await hasGrant(actor.userId, productionId, "event", edge.eventId, "reports", "view")) return true;
  const dept = await getPool().query(
    `SELECT 1 FROM event_participant
     WHERE event_id = $1 AND user_id = $2 AND department_id IS NOT NULL LIMIT 1`,
    [edge.eventId, actor.userId],
  );
  return dept.rows.length > 0;
}

/** 单实例可见性判定（内容面）。wiki 不存在时返回 false。 */
export async function canViewWiki(
  actor: GrantActor,
  productionId: string,
  wikiId: string,
): Promise<boolean> {
  if (actor.isAdmin || actor.isOwner) return true;
  const pool = getPool();
  // is_public 活在 node 壳上（#420）；无壳的 wiki 行（不变量破损）按不公开处理
  const w = await pool.query<WikiVisibilityRow>(
    `SELECT w.id::text AS id, COALESCE(n.is_public, false) AS is_public, n.id AS node_id
     FROM wiki w LEFT JOIN node n ON n.wiki_id = w.id
     WHERE w.id = $1::uuid AND w.production_id = $2`,
    [wikiId, productionId],
  );
  if (!w.rows[0]) return false;
  // #236 policy.wiki_public_enabled：关掉后 is_public 失效，可见性只认个人行 /
  // 部门分享 / 挂载边。注意 wiki 的 is_public 比 asset 的宽一档——它是**无条件全员
  // 可见**（绕过所有 grant），asset 那个只是免除挂载要求、仍需能力票。
  if (w.rows[0].is_public && await isPolicyOn(productionId, "policy.wiki_public_enabled")) return true;
  if (await hasGrant(actor.userId, productionId, "wiki", wikiId, "*", "view")) return true;
  const deptShare = await pool.query(
    `SELECT 1 FROM node_dept_share ns
     JOIN node n ON n.id = ns.node_id
     JOIN production_dept_member pdm ON pdm.dept_id = ns.dept_id
     WHERE n.wiki_id = $1::uuid AND pdm.user_id = $2 AND pdm.production_id = $3 LIMIT 1`,
    [wikiId, actor.userId, productionId],
  );
  if (deptShare.rows.length > 0) return true;
  // 挂载让渡（#420 第二批拍板）：文档的 node 被挂到 scene/block/cue/event 上，
  // 宿主可见 ⇒ 文档可读。与 asset 挂载让渡同一判定核（lib/node/host-visibility），
  // 与 report/note 边先例同语义。枚举面照旧不投票。
  if (w.rows[0].node_id) {
    const conceded = await mountConcededNodeIds(actor, productionId, { nodeIds: [w.rows[0].node_id] });
    if (conceded.has(w.rows[0].node_id)) return true;
  }
  // 挂载边（直接 report 边 ∪ 经 note 边到其 report）——#420 后边键在 node 上
  const edges = await pool.query<{ report_id: string; event_id: string; published: boolean }>(
    `SELECT er.id AS report_id, er.event_id, (er.published_at IS NOT NULL) AS published
     FROM event_report er JOIN node nd ON nd.id = er.node_id
     WHERE nd.wiki_id = $1::uuid
     UNION
     SELECT er.id, er.event_id, (er.published_at IS NOT NULL)
     FROM event_report_note n
     JOIN node nn ON nn.id = n.node_id
     JOIN event_report er ON er.id = n.report_id
     WHERE nn.wiki_id = $1::uuid`,
    [wikiId],
  );
  for (const e of edges.rows) {
    if (await reportEdgeVisible(actor, productionId, {
      reportId: e.report_id, eventId: e.event_id, published: e.published,
    })) return true;
  }
  return false;
}

/**
 * 列表过滤：返回该用户可见的 wiki id 集合（或 wildcard=true 表示全可见）。
 * 与 canViewWiki 同语义的集合式实现，供文档树列表/目录/搜索使用。
 */
export async function listVisibleWikiIds(
  actor: GrantActor,
  productionId: string,
): Promise<{ wildcard: boolean; ids: Set<string> }> {
  if (actor.isAdmin || actor.isOwner) return { wildcard: true, ids: new Set() };
  const pool = getPool();
  const ids = new Set<string>();

  const granted = await listGrantedResourceIds(actor.userId, productionId, "wiki", "*", "view");
  if (granted.wildcard) return { wildcard: true, ids: new Set() };
  for (const id of granted.ids) ids.add(id);

  // 与 canViewWiki 同源：is_public 这条让渡受 policy.wiki_public_enabled 管。
  // 单实例判定与列表判定**必须同读**——分叉即「列表看得见、点进去 403」（批D 教训）。
  const wikiPublicOn = await isPolicyOn(productionId, "policy.wiki_public_enabled");
  // is_public / 部门分享都活在 node 壳上（#420），按 wiki_id 目标列对撞
  const structural = await pool.query<{ id: string }>(
    `SELECT w.id::text AS id FROM wiki w
     LEFT JOIN node n ON n.wiki_id = w.id
     WHERE w.production_id = $1 AND (
       ($3 AND n.is_public)
       OR EXISTS (SELECT 1 FROM node_dept_share ns
                  JOIN production_dept_member pdm ON pdm.dept_id = ns.dept_id
                  WHERE ns.node_id = n.id AND pdm.user_id = $2::uuid AND pdm.production_id = $1)
     )`,
    [productionId, actor.userId, wikiPublicOn],
  );
  for (const r of structural.rows) ids.add(r.id);

  // 挂载边推导（集合式）：
  //   已发布报告 → 事件域 view 全量；draft 通道 → report 实例行 / publication@view /
  //   event reports@view / 部门参与者。note 边随其 report。
  const domainView = await hasEventDomainView(actor, productionId);
  const [reportMeta, reportPub, eventReports] = await Promise.all([
    listGrantedResourceIds(actor.userId, productionId, "report", "meta", "view"),
    listGrantedResourceIds(actor.userId, productionId, "report", "publication", "view"),
    listGrantedResourceIds(actor.userId, productionId, "event", "reports", "view"),
  ]);
  const mounted = await pool.query<{ id: string }>(
    `WITH edges AS (
       SELECT nd.wiki_id, er.id AS report_id, er.event_id, er.published_at
       FROM event_report er
       JOIN node nd ON nd.id = er.node_id
       JOIN production_event pe ON pe.id = er.event_id
       WHERE pe.production_id = $1
       UNION ALL
       SELECT nn.wiki_id, er.id, er.event_id, er.published_at
       FROM event_report_note n
       JOIN node nn ON nn.id = n.node_id
       JOIN event_report er ON er.id = n.report_id
       JOIN production_event pe ON pe.id = er.event_id
       WHERE pe.production_id = $1
     )
     SELECT DISTINCT e.wiki_id::text AS id FROM edges e
     WHERE (e.published_at IS NOT NULL AND $2)
        OR ($3 OR e.report_id = ANY($4::text[]))
        OR ($5 OR e.report_id = ANY($6::text[]))
        OR ($7 OR e.event_id = ANY($8::text[]))
        OR EXISTS (SELECT 1 FROM event_participant ep
                   WHERE ep.event_id = e.event_id AND ep.user_id = $9::uuid
                     AND ep.department_id IS NOT NULL)`,
    [productionId, domainView,
     reportMeta.wildcard, reportMeta.ids,
     reportPub.wildcard, reportPub.ids,
     eventReports.wildcard, eventReports.ids,
     actor.userId],
  );
  for (const r of mounted.rows) ids.add(r.id);

  // 挂载让渡（集合式，与 canViewWiki 的单点分支同读共享核——不得分叉）
  const conceded = await mountConcededNodeIds(actor, productionId, { kind: "wiki" });
  if (conceded.size > 0) {
    const concededWikis = await pool.query<{ id: string }>(
      `SELECT wiki_id::text AS id FROM node
       WHERE id = ANY($1::text[]) AND wiki_id IS NOT NULL`,
      [[...conceded]],
    );
    for (const r of concededWikis.rows) ids.add(r.id);
  }

  return { wildcard: false, ids };
}

// ─── 写面门（行判定，admin/owner 旁路由 hasEffectiveGrant 调用侧承担）──────────

export async function canEditWiki(actor: GrantActor, productionId: string, wikiId: string): Promise<boolean> {
  if (actor.isAdmin || actor.isOwner) return true;
  return hasGrant(actor.userId, productionId, "wiki", wikiId, "*", "edit");
}

export async function canDeleteWiki(actor: GrantActor, productionId: string, wikiId: string): Promise<boolean> {
  if (actor.isAdmin || actor.isOwner) return true;
  return hasGrant(actor.userId, productionId, "wiki", wikiId, "*", "delete");
}

/** 分享面（个人授权/部门分享/公开开关）统一走 grants@edit（保留段，'*' 不覆盖）。 */
export async function canShareWiki(actor: GrantActor, productionId: string, wikiId: string): Promise<boolean> {
  if (actor.isAdmin || actor.isOwner) return true;
  return hasGrant(actor.userId, productionId, "wiki", wikiId, "grants", "edit");
}

/**
 * 写面的**集合式**实现（#355 移入面板）：一次查出该用户能 edit 哪些 wiki。
 *
 * 与 canEditWiki 逐点同键同语义（`wiki/<id>@edit`，resource_id 通配走
 * listGrantedResourceIds 的 wildcard 分支）——移入候选可能是整个库，逐条调
 * canEditWiki 就是 N 次查询。判定权威仍在路由的 canEditWiki 上，这里只供前端
 * 把「移入本体」灰掉。
 */
export async function listEditableWikiIds(
  actor: GrantActor, productionId: string,
): Promise<{ wildcard: boolean; ids: Set<string> }> {
  if (actor.isAdmin || actor.isOwner) return { wildcard: true, ids: new Set() };
  const granted = await listGrantedResourceIds(actor.userId, productionId, "wiki", "*", "edit");
  return granted.wildcard
    ? { wildcard: true, ids: new Set() }
    : { wildcard: false, ids: new Set(granted.ids) };
}
