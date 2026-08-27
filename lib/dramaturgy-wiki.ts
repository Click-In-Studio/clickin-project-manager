import type { WikiListEntry } from "./wiki-db";
import type { WikiAliasEntry } from "./wiki-alias-db";

/** Return the descendants of the system dramaturgy root, preserving library order. */
export function listDramaturgyWikiSubtree(
  wikis: WikiListEntry[],
  rootId: string | null,
): WikiListEntry[] {
  if (!rootId) return [];
  const byId = new Map(wikis.map((wiki) => [wiki.id, wiki]));

  return wikis.filter((wiki) => {
    if (wiki.id === rootId) return false;
    const visited = new Set<string>();
    let parentId = wiki.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === rootId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return false;
  });
}

/**
 * 子树里的软链接别名（#358）。成员判据是**位置**：别名挂在子树内的某个容器下
 * （或直接挂在根下）就属于灵感库——和真实文档同一条判据，别名不因为目标在子树外
 * 就掉出去，那正是软链接的用途。
 *
 * 注意这只是「位置在子树内」，不是 #355 说的「子树 ∪ 软连接集合」那条更大的成员
 * 判据（把子树外的文档算作灵感库成员）——那一条属于 #355。
 */
export function listDramaturgyWikiAliases(
  aliases: WikiAliasEntry[],
  subtree: WikiListEntry[],
  rootId: string | null,
): WikiAliasEntry[] {
  if (!rootId) return [];
  const inside = new Set<string>([rootId, ...subtree.map((wiki) => wiki.id)]);
  return aliases.filter((alias) => alias.parentId !== null && inside.has(alias.parentId));
}

/** 一个 id 集合（含通配）的成员判定——与 listEnumerableWikiIds / listEditableWikiIds 的返回同形。 */
type IdSet = { wildcard: boolean; ids: Set<string> };
const inSet = (s: IdSet, id: string) => s.wildcard || s.ids.has(id);

/** 移入面板的一个候选（#355）。 */
export type WikiMoveInCandidate = {
  id: string;
  title: string | null;
  parentId: string | null;
  /**
   * 能不能把**本体**移进来。镜像路由那三道门里与目标无关的两道：
   *   canEditWiki(本篇) ∧ canWriteWikiContainer(本篇的源父)
   * 目标父那两道（可枚举 ∧ 容器可写）在灵感库根上恒真——根是系统锚点，
   * isWikiAnchor 分支直接放行，与 POST /wiki 的锚点落位同一条静态论证。
   *
   * 这是**前端灰化**用的镜像，不是判定权威：路由照样逐点跑 canEditWiki。镜像偏
   * 松只会让人撞一个 403，偏紧只会让人少一个按钮——两边都不泄漏。
   */
  canMoveBody: boolean;
  /** 灵感库里已有指向它的链接（只数得出**自己看得见**的那些，故不给精确数字）。 */
  linked: boolean;
};

/**
 * 「移入」候选（#355）：子树外、该用户可枚举的文档。
 *
 * 排除子树内的文档——它们已经是灵感库成员，移入无意义。别名不作候选：链接指向
 * 的永远是真实文档（链式别名在 #358 里结构上就不存在）。
 *
 * 系统锚点（报告归档根等）也不作候选：移它的本体＝把整棵报告树拽进灵感库，链接它
 * 又只会得到一个不展开子树的叶子（别名是叶子）。它的**子文档**照常是候选。
 */
export function listDramaturgyMoveInCandidates(
  wikis: WikiListEntry[],
  subtree: WikiListEntry[],
  rootId: string | null,
  perms: { enumerable: IdSet; editable: IdSet },
  aliasesInside: WikiAliasEntry[] = [],
): WikiMoveInCandidate[] {
  const inside = new Set<string>([...(rootId ? [rootId] : []), ...subtree.map((w) => w.id)]);
  const byId = new Map(wikis.map((w) => [w.id, w]));
  const linkedTargets = new Set(
    aliasesInside.filter((a) => a.targetType === "wiki").map((a) => a.targetId),
  );

  return wikis
    .filter((w) => !inside.has(w.id) && !w.isAnchor && inSet(perms.enumerable, w.id))
    .map((w) => {
      const parent = w.parentId ? byId.get(w.parentId) : null;
      // 源父容器可写：顶层无人持有 root 的 *@edit（恒真）；系统锚点无主（恒真）
      const sourceWritable = w.parentId === null
        || (parent?.isAnchor ?? false)
        || inSet(perms.editable, w.parentId);
      return {
        id: w.id,
        title: w.title,
        parentId: w.parentId,
        canMoveBody: inSet(perms.editable, w.id) && sourceWritable,
        linked: linkedTargets.has(w.id),
      };
    });
}
