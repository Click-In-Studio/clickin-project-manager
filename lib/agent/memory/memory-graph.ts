// 只计算连通分量，不把传递连通解释成直接重复或冲突。
export function connectedComponents(
  ids: string[],
  edges: Array<{ leftId: string; rightId: string }>,
): string[][] {
  const neighbors = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!neighbors.has(edge.leftId) || !neighbors.has(edge.rightId))
      throw new Error("关系包含组外条目");
    neighbors.get(edge.leftId)!.push(edge.rightId);
    neighbors.get(edge.rightId)!.push(edge.leftId);
  }
  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    const members = [id];
    visited.add(id);
    for (let i = 0; i < members.length; i++) {
      for (const next of neighbors.get(members[i])!) {
        if (visited.has(next)) continue;
        visited.add(next);
        members.push(next);
      }
    }
    groups.push(members);
  }
  return groups;
}
