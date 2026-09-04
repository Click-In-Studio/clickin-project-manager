import { getPool } from "../pg";
import { hasGrant, listGrantedResourceIds, type GrantActor } from "../grant-check";
import { isWikiAnchor } from "./tree";

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

/**
 * 本地可枚举谓词（判定式的第二合取项），SQL 片段形式**只写这一份**。
 *
 * 两个读者：下面的递归 CTE（沿祖先链求交）与 #358 别名解析器（只要本地这一项，
 * 不含目标自己的祖先链）。参数位固定：$1=production_id、$2=meta@view 行的 id 数组、
 * $3=user_id，表别名固定为 `w`。抠成常量是因为这条谓词一旦双写，两个面就会各自
 * 长出分支——canViewWiki / listVisibleWikiIds 的教训（#357 症状③）不必重演第二遍。
 */
const LOCAL_ENUMERABLE_PRED = `(w.listable
   OR w.id::text = ANY($2::text[])
   OR EXISTS (SELECT 1 FROM wiki_dept_share ws
              JOIN production_dept_member pdm ON pdm.dept_id = ws.dept_id
              WHERE ws.wiki_id = w.id AND pdm.user_id = $3::uuid
                AND pdm.production_id = $1))`;

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
       SELECT w.id, w.parent_id, ${LOCAL_ENUMERABLE_PRED} AS ok
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

/**
 * **本地**可枚举筛选（#358 别名判定式的第二合取项）：给定候选 id，返回其中
 * 「目标自身允许被列出」的那些——只跑本地谓词，**不含**目标自己的祖先链。
 *
 * 别名给目标的是第二个**位置**，位置这一维由别名自己的父链承担（listEnumerableWikiIds
 * 已经算过了）；节点自身属性（listable / meta@view 行 / 部门分享）一分不放。
 * 若这里改用全可枚举（含目标祖先链），别名对「把埋在私密子树里的一篇提到灵感库」
 * 这个主用途就永远不可见——功能当场失效（#358 拍板）。
 */
export async function localEnumerableWikiIds(
  actor: GrantActor, productionId: string, candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  if (actor.isAdmin || actor.isOwner) return new Set(candidateIds);
  const granted = await listGrantedResourceIds(actor.userId, productionId, "wiki", "meta", "view");
  if (granted.wildcard) return new Set(candidateIds);
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT w.id::text AS id FROM wiki w
     WHERE w.production_id = $1 AND w.id::text = ANY($4::text[]) AND ${LOCAL_ENUMERABLE_PRED}`,
    [productionId, [...granted.ids], actor.userId, candidateIds],
  );
  return new Set(rows.map(r => r.id));
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
 *   - parentId=null（顶层）：**根容器上不存在"edit 权"这个说法**，没有实体可以
 *     持有它。于是"把 X 提到顶层"只受源父那道门约束——只有移出门，没有移入门。
 *     这不是妥协，是根容器的本体决定的：deleteWiki 把子文档提根（FK SET NULL）
 *     同理，行使的是对源容器自身的权限，不需要额外的落位门。
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
