import { listWikiLibrary, type WikiListEntry } from "./wiki-db";
import { listEnumerableWikiIds } from "./wiki-perm";
import { listEnumerableWikiAliases, type WikiAliasEntry } from "./wiki-alias-db";
import { listDramaturgyWikiSubtree, listDramaturgyWikiAliases } from "./dramaturgy-wiki";
import type { GrantActor } from "./grant-check";

// ─── 目录树的唯一取数口（#357 枚举面 + #358 别名）────────────────────────────
//
// 树的节点集 = 可枚举的 wiki 行 ∪ 可枚举的别名行。两个消费方各自拼一遍，就会各自
// 决定别名怎么过门——那正是 #357 症状① 的成因（同一份数据、两个入口、不同答案）。
// 所以页面/路由一律走这一个函数，不各自调 listWikiLibrary + 过滤。

export type WikiTree = { wikis: WikiListEntry[]; aliases: WikiAliasEntry[] };

export async function listWikiTreeFor(actor: GrantActor, productionId: string): Promise<WikiTree> {
  const [all, enumerable] = await Promise.all([
    listWikiLibrary(productionId),
    listEnumerableWikiIds(actor, productionId),
  ]);
  return {
    wikis: enumerable.wildcard ? all : all.filter(w => enumerable.ids.has(w.id)),
    aliases: await listEnumerableWikiAliases(actor, productionId, enumerable),
  };
}

/**
 * 作用域化工作区（「构作 · 灵感文档」）的取数口。
 *
 * subtree 是在**全量**上算的（未过枚举面）——越界判定与侧栏必须同源，见 #352。
 * 别名的成员判据同样是位置：挂在子树内的容器下即属于本工作区。
 */
export async function listDramaturgyTreeFor(
  actor: GrantActor, productionId: string, rootId: string | null,
): Promise<WikiTree & { subtree: WikiListEntry[] }> {
  const [all, enumerable] = await Promise.all([
    listWikiLibrary(productionId),
    listEnumerableWikiIds(actor, productionId),
  ]);
  const subtree = listDramaturgyWikiSubtree(all, rootId);
  const enumerableAliases = await listEnumerableWikiAliases(actor, productionId, enumerable);
  return {
    subtree,
    wikis: enumerable.wildcard ? subtree : subtree.filter(w => enumerable.ids.has(w.id)),
    aliases: listDramaturgyWikiAliases(enumerableAliases, subtree, rootId),
  };
}
