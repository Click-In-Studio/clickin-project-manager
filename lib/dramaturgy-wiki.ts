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
