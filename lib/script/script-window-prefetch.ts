// 剧本正文后台补窗的纯调度算术。这里只决定下一窗的位置，不碰 fetch / React，
// 让“从当前视窗向外扩散、前台随时可插队”的网络策略可以单独回归。

export type ScriptWindowRange = { start: number; end: number };

export function nextIdlePrefetchRange(
  totalCount: number,
  viewport: ScriptWindowRange,
  isMissing: (index: number) => boolean,
  limit = 480,
): { start: number; limit: number } | null {
  if (totalCount <= 0 || limit <= 0) return null;
  const safeStart = Math.max(0, Math.min(totalCount, Math.floor(viewport.start)));
  const safeEnd = Math.max(safeStart, Math.min(totalCount, Math.floor(viewport.end)));
  const safeLimit = Math.max(1, Math.floor(limit));

  // 同距先向阅读方向（后方）预取；一窗到齐后，另一侧会成为更近的一侧，
  // 因而自然形成“后、前、再后、再前”的向外扩散顺序。
  for (let distance = 0; distance < totalCount; distance++) {
    const after = safeEnd + distance;
    if (after < totalCount && isMissing(after)) {
      return { start: after, limit: Math.min(safeLimit, totalCount - after) };
    }

    const before = safeStart - 1 - distance;
    if (before >= 0 && isMissing(before)) {
      const start = Math.max(0, before - safeLimit + 1);
      return { start, limit: before - start + 1 };
    }
  }

  return null;
}
