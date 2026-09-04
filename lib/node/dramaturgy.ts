import type { NodeEntry } from "./db";

// ─── 灵感库（戏剧构作工作区）的纯函数（原 lib/wiki/dramaturgy.ts node 化）─────
// 锚下任意 kind 合法（#420）：PDF asset 可以活在灵感库根下，subtree 判据只看
// 位置不看 kind。

/** 系统灵感库根的后代（保持库序）。 */
export function listDramaturgySubtree(
  nodes: NodeEntry[],
  rootId: string | null,
): NodeEntry[] {
  if (!rootId) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.filter((n) => {
    if (n.id === rootId) return false;
    const visited = new Set<string>();
    let parentId = n.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === rootId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return false;
  });
}

/** 子树里的软链接：成员判据是**位置**（挂在子树内的容器下或根下）——link 不因
 *  目标在子树外就掉出去，那正是软链接的用途（#358）。 */
export function listDramaturgyLinks(
  links: NodeEntry[],
  subtree: NodeEntry[],
  rootId: string | null,
): NodeEntry[] {
  if (!rootId) return [];
  const inside = new Set<string>([rootId, ...subtree.map((n) => n.id)]);
  return links.filter((l) => l.parentId !== null && inside.has(l.parentId));
}

type IdSet = { wildcard: boolean; ids: Set<string> };
const inSet = (s: IdSet, id: string) => s.wildcard || s.ids.has(id);

/** 移入面板候选（#355）。canMoveBody 是前端灰化镜像，判定权威在路由。 */
export type NodeMoveInCandidate = {
  id: string;
  title: string | null;
  parentId: string | null;
  canMoveBody: boolean;
  /** 灵感库里已有指向它的链接（只数自己看得见的，故不给精确数字）。 */
  linked: boolean;
};

/**
 * 「移入」候选：子树外、该用户可枚举的节点。系统锚点不作候选（移它=拽整棵归档
 * 树）；link 不作候选（链式 link 结构上不存在）。
 * editable 是 **wiki 内容域**的 edit 集合——wiki 节点按 wikiId 对撞；folder/asset
 * 节点的「本体可移」镜像：folder 无主恒可（容器写门 folder 豁免的镜像）、asset
 * 节点按上传者行集的实际持有走 editable 以外的通道，本批先只镜像 wiki（asset
 * 移入灵感库走软链接为主，本体移动仍可经路由逐点判）。
 */
export function listDramaturgyMoveInCandidates(
  nodes: NodeEntry[],
  subtree: NodeEntry[],
  rootId: string | null,
  perms: { enumerable: IdSet; editable: IdSet },
  linksInside: NodeEntry[] = [],
): NodeMoveInCandidate[] {
  const inside = new Set<string>([...(rootId ? [rootId] : []), ...subtree.map((n) => n.id)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const linkedTargets = new Set(linksInside.map((l) => l.linkTargetId).filter(Boolean));

  return nodes
    .filter((n) => n.kind !== "link" && !inside.has(n.id) && !n.isAnchor
      && inSet(perms.enumerable, n.id))
    .map((n) => {
      const parent = n.parentId ? byId.get(n.parentId) : null;
      const sourceWritable = n.parentId === null
        || (parent?.isAnchor ?? false)
        || (parent?.kind === "folder")
        || (parent?.kind === "wiki" && parent.wikiId !== null && inSet(perms.editable, parent.wikiId));
      const bodyEditable = n.kind === "wiki" && n.wikiId !== null && inSet(perms.editable, n.wikiId);
      return {
        id: n.id,
        title: n.displayTitle,
        parentId: n.parentId,
        canMoveBody: bodyEditable && sourceWritable,
        linked: linkedTargets.has(n.id),
      };
    });
}
