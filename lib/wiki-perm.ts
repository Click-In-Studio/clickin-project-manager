import { getPool } from "./pg";
import { isPolicyOn } from "./policy-db";
import { hasGrant, listGrantedResourceIds, type GrantActor } from "./grant-check";
import { hasEventDomainView } from "./event-permissions";
import { isWikiAnchor } from "./wiki-db";

// ─── wiki 文档库 W3：可见性判定（账本 §4.2，asset 隐私模型同构）─────────────────
//
// 可见(user, wiki) = 个人 grant 行（创建者行集 / grants@edit 持有者分享）
//                  ∨ is_public（全体，结构面）
//                  ∨ dept 分享面（wiki_dept_share ∩ 用户部门，判定时查成员零 sweep）
//                  ∨ ∃挂载边: 宿主可见（report 边→报告可见性；note 边→其 report 可见性）
//
// 挂载/分享面永不物化 grant 行（§0.9 负面清单）；解除挂载/分享即收缩。
// 标题=目录级信息沿引用边流出（§4.1），由 mention-resolve 承担，不经本判定。
//
// 【两个面，别混】（#357）——本段是**内容面**：能不能读这篇。
// 目录树用的是**枚举面**（本文件下半 listEnumerableWikiIds）：能不能在目录里列到它。
// 名字沿引用边逐点流出 ≠ 名字集合可枚举，两者是不同的披露类，不得互相推导。
// 不变量：枚举面的任何变化不得改变 canViewWiki 的判定结果。

type WikiVisibilityRow = { id: string; is_public: boolean };

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
  const w = await pool.query<WikiVisibilityRow>(
    `SELECT id::text AS id, is_public FROM wiki WHERE id = $1::uuid AND production_id = $2`,
    [wikiId, productionId],
  );
  if (!w.rows[0]) return false;
  // #236 policy.wiki_public_enabled：关掉后 is_public 失效，可见性只认个人行 /
  // 部门分享 / 挂载边。注意 wiki 的 is_public 比 asset 的宽一档——它是**无条件全员
  // 可见**（绕过所有 grant），asset 那个只是免除挂载要求、仍需能力票。
  if (w.rows[0].is_public && await isPolicyOn(productionId, "policy.wiki_public_enabled")) return true;
  if (await hasGrant(actor.userId, productionId, "wiki", wikiId, "*", "view")) return true;
  const deptShare = await pool.query(
    `SELECT 1 FROM wiki_dept_share ws
     JOIN production_dept_member pdm ON pdm.dept_id = ws.dept_id
     WHERE ws.wiki_id = $1::uuid AND pdm.user_id = $2 AND pdm.production_id = $3 LIMIT 1`,
    [wikiId, actor.userId, productionId],
  );
  if (deptShare.rows.length > 0) return true;
  // 挂载边（直接 report 边 ∪ 经 note 边到其 report）
  const edges = await pool.query<{ report_id: string; event_id: string; published: boolean }>(
    `SELECT er.id AS report_id, er.event_id, (er.published_at IS NOT NULL) AS published
     FROM event_report er WHERE er.wiki_id = $1::uuid
     UNION
     SELECT er.id, er.event_id, (er.published_at IS NOT NULL)
     FROM event_report_note n JOIN event_report er ON er.id = n.report_id
     WHERE n.wiki_id = $1::uuid`,
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
  const structural = await pool.query<{ id: string }>(
    `SELECT w.id::text AS id FROM wiki w
     WHERE w.production_id = $1 AND (
       ($3 AND w.is_public)
       OR EXISTS (SELECT 1 FROM wiki_dept_share ws
                  JOIN production_dept_member pdm ON pdm.dept_id = ws.dept_id
                  WHERE ws.wiki_id = w.id AND pdm.user_id = $2::uuid AND pdm.production_id = $1)
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
       SELECT er.wiki_id, er.id AS report_id, er.event_id, er.published_at
       FROM event_report er JOIN production_event pe ON pe.id = er.event_id
       WHERE pe.production_id = $1
       UNION ALL
       SELECT n.wiki_id, er.id, er.event_id, er.published_at
       FROM event_report_note n
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

  return { wildcard: false, ids };
}

// ─── 枚举面（#357）：目录树可见性，与上面的内容面正交 ───────────────────────
//
//   可枚举(u, X) ⟺ 可枚举(u, parent(X)) ∧ 本地可枚举(u, X)
//   本地可枚举(u, X) ⟺ X.listable ∨ u 持 wiki/X meta@view 行 ∨ X 部门分享命中 u
//
// 第二合取项的分界：**定向分享（个人行集 / 部门分享）⇒ 可枚举**——分享是冲着某个人
// 或某个部门去的，分享者的意图就是让对方找得到；**泛在开关各管各的面**——listable
// 管枚举、is_public 管内容，is_public 刻意**不**蕴含可枚举，"公开可读但不在目录里
// （靠链接传播）"是个合法且需要能表达的状态。
// 个人分享此前能进树只是因为 WIKI_LEVEL_ROW_SETS 恰好发了 meta@view 行，部门分享
// 走结构面不落行就掉出去了——那是实现不对称，不是设计。
//
// 前置合取项即不变量 E(子) ⊆ E(父)：任何人看到的都是**含根的连通子树**，树上不可能
// 出现断链（#357 症状①），隐一个节点即隐整棵子树，零级联写、不可能漂移。
// 沿祖先链求交、永不物化（§0.9 姿态：结构面不落 grant 行，收窄即刻生效）。
//
// 与内容面的关系：`*@view` 的 sub 通配天然命中 meta（grant-check RESERVED_SUBS 之外
// 的段 `resource_sub IN ($5,'*')`），所以内容可读者只要祖先链通就在树里，装门零迁移。
// 反向不成立——能在树里看到标题 ≠ 能读内容，内容仍走 canViewWiki 四通道。
//
// **本面只写这一份实现**（集合式），单点判定＝查集合，不重蹈 canViewWiki /
// listVisibleWikiIds 双写的覆辙（#357 症状③）。

export async function listEnumerableWikiIds(
  actor: GrantActor,
  productionId: string,
): Promise<{ wildcard: boolean; ids: Set<string> }> {
  if (actor.isAdmin || actor.isOwner) return { wildcard: true, ids: new Set() };
  // meta@view 通配＝每个节点都过第二合取项 → 自根归纳全树可枚举
  const granted = await listGrantedResourceIds(actor.userId, productionId, "wiki", "meta", "view");
  if (granted.wildcard) return { wildcard: true, ids: new Set() };
  const ids = [...granted.ids];
  // 本地可枚举：listable ∨ 个人行 ∨ 部门分享（与 canViewWiki 的部门面同一张表、
  // 同一判据，判定时查成员、零 sweep——退组即刻收缩）
  const { rows } = await getPool().query<{ id: string }>(
    `WITH RECURSIVE local AS (
       SELECT w.id, w.parent_id,
              (w.listable
               OR w.id::text = ANY($2::text[])
               OR EXISTS (SELECT 1 FROM wiki_dept_share ws
                          JOIN production_dept_member pdm ON pdm.dept_id = ws.dept_id
                          WHERE ws.wiki_id = w.id AND pdm.user_id = $3::uuid
                            AND pdm.production_id = $1)) AS ok
       FROM wiki w WHERE w.production_id = $1
     ),
     enumerable AS (
       SELECT l.id, 1 AS depth FROM local l WHERE l.parent_id IS NULL AND l.ok
       UNION ALL
       SELECT c.id, e.depth + 1 FROM local c JOIN enumerable e ON c.parent_id = e.id
       WHERE e.depth < 100 AND c.ok
     )
     SELECT DISTINCT id::text AS id FROM enumerable`,
    [productionId, ids, actor.userId],
  );
  return { wildcard: false, ids: new Set(rows.map(r => r.id)) };
}

/** 单点枚举判定＝查集合（刻意不另写一份上溯 SQL，见上方双写教训）。 */
export async function canEnumerateWiki(
  actor: GrantActor, productionId: string, wikiId: string,
): Promise<boolean> {
  const e = await listEnumerableWikiIds(actor, productionId);
  return e.wildcard || e.ids.has(wikiId);
}

/** 落位门之一（#357 症状⑤，枚举面）：只能把文档挂到自己能枚举的父下——枚举权
 *  挂在节点上，往一个自己列不出的容器里塞东西没有语义。null=顶层，恒允许。 */
export async function canPlaceWikiUnder(
  actor: GrantActor, productionId: string, parentId: string | null,
): Promise<boolean> {
  if (parentId === null) return true;
  return canEnumerateWiki(actor, productionId, parentId);
}

/**
 * 落位门之二（#357 症状⑤，写面）：容器写权＝**父文档的 `*@edit`**，只认直接父、
 * 不沿祖先链继承（与内容面"不继承"一致）。增删/重排某个容器的子项是对该容器的
 * 改动，不是对被移动那篇文档的改动——后者另由 canEditWiki 把关，两道门是"且"。
 *
 * 键不新增：`resource_sub IN ($5,'*')` 让 `*@edit` 天然命中任何子段（同 meta@view
 * 那次的零迁移手法）。
 *
 * 两处豁免：
 *   - parentId=null（顶层）：没有容器可以持有权限，无门。
 *   - 系统锚点：无主公共容器，全库无人持其 *@edit，见 isWikiAnchor 头注释。
 */
export async function canWriteWikiContainer(
  actor: GrantActor, productionId: string, parentId: string | null,
): Promise<boolean> {
  if (parentId === null) return true;
  if (actor.isAdmin || actor.isOwner) return true;
  if (await isWikiAnchor(parentId)) return true;
  return hasGrant(actor.userId, productionId, "wiki", parentId, "*", "edit");
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
