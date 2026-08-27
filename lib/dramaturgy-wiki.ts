import type { WikiListEntry } from "./wiki-db";

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
