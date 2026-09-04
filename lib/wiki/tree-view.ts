import { listWikiLibrary } from "./tree";
import { type WikiListEntry } from "./types";
import { listEnumerableWikiIds } from "./enum-perm";
import { listEditableWikiIds } from "./perm";
import { listEnumerableWikiAliases, type WikiAliasEntry } from "./alias";
import {
  listDramaturgyWikiSubtree, listDramaturgyWikiAliases, listDramaturgyMoveInCandidates,
  type WikiMoveInCandidate,
} from "./dramaturgy";
import type { GrantActor } from "../grant-check";

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
): Promise<WikiTree & { subtree: WikiListEntry[]; moveIn: WikiMoveInCandidate[] }> {
  const [all, enumerable, editable] = await Promise.all([
    listWikiLibrary(productionId),
    listEnumerableWikiIds(actor, productionId),
    listEditableWikiIds(actor, productionId),
  ]);
  const subtree = listDramaturgyWikiSubtree(all, rootId);
  const enumerableAliases = await listEnumerableWikiAliases(actor, productionId, enumerable);
  const aliases = listDramaturgyWikiAliases(enumerableAliases, subtree, rootId);
  return {
    subtree,
    wikis: enumerable.wildcard ? subtree : subtree.filter(w => enumerable.ids.has(w.id)),
    aliases,
    // 移入候选（#355）：子树外的可枚举文档。作用域工作区的侧栏只有子树，选择器
    // 里没有子树外的东西可选——这个列表就是那个入口的候选来源。
    moveIn: listDramaturgyMoveInCandidates(all, subtree, rootId, { enumerable, editable }, aliases),
  };
}
