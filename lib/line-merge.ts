/**
 * 行级三路合并（wiki 多人协作，拍板"简单就以行为单位"）。
 *
 * mergeLines(base, mine, theirs)：
 *   - 双方相对 base 的改动落在不相交的行区间 → 都保留
 *   - 区间重叠（真冲突）→ mine 胜（保存者视角的 LWW；调用方决定谁是 mine）
 *
 * 实现：diffArrays 各算一侧的 hunks（锚定 base 行号），按 baseStart 归并；
 * 与已采纳 hunk 重叠的对侧 hunk 丢弃。
 */
import { diffArrays } from "diff";

type Hunk = {
  baseStart: number;   // base 行号（0-based，含）
  baseEnd: number;     // base 行号（不含）；纯插入时 == baseStart
  lines: string[];     // 替换/插入的行
};

function toHunks(base: string[], target: string[]): Hunk[] {
  const parts = diffArrays(base, target);
  const hunks: Hunk[] = [];
  let baseIdx = 0;
  let pending: Hunk | null = null;

  const flush = () => { if (pending) { hunks.push(pending); pending = null; } };

  for (const part of parts) {
    if (part.added) {
      // 插入：并入当前 pending（删除+插入=替换），否则锚定当前位置的纯插入
      if (!pending) pending = { baseStart: baseIdx, baseEnd: baseIdx, lines: [] };
      pending.lines.push(...part.value);
    } else if (part.removed) {
      if (!pending) pending = { baseStart: baseIdx, baseEnd: baseIdx, lines: [] };
      pending.baseEnd = baseIdx + part.value.length;
      baseIdx += part.value.length;
    } else {
      flush();
      baseIdx += part.value.length;
    }
  }
  flush();
  return hunks;
}

function overlaps(a: Hunk, b: Hunk): boolean {
  // 纯插入（空区间）只与"覆盖其锚点的替换区间"冲突；两个同锚点纯插入视为冲突
  if (a.baseStart === a.baseEnd && b.baseStart === b.baseEnd) return a.baseStart === b.baseStart;
  if (a.baseStart === a.baseEnd) return a.baseStart > b.baseStart && a.baseStart < b.baseEnd;
  if (b.baseStart === b.baseEnd) return b.baseStart > a.baseStart && b.baseStart < a.baseEnd;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

export function mergeLines(base: string, mine: string, theirs: string): string {
  if (mine === theirs) return mine;
  if (base === mine) return theirs;
  if (base === theirs) return mine;

  const baseLines = base.split("\n");
  const mineHunks = toHunks(baseLines, mine.split("\n"));
  const theirHunks = toHunks(baseLines, theirs.split("\n"));

  // mine 优先：theirs 中与任一 mine hunk 重叠的丢弃
  const kept: Array<Hunk & { side: "mine" | "theirs" }> = mineHunks.map(h => ({ ...h, side: "mine" as const }));
  for (const th of theirHunks) {
    if (!mineHunks.some(mh => overlaps(mh, th))) kept.push({ ...th, side: "theirs" });
  }
  kept.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd
    // 同锚点纯插入按 mine 先（稳定且偏向保存者）
    || (a.side === "mine" ? -1 : 1));

  const out: string[] = [];
  let cursor = 0;
  for (const h of kept) {
    if (h.baseStart > cursor) out.push(...baseLines.slice(cursor, h.baseStart));
    out.push(...h.lines);
    cursor = Math.max(cursor, h.baseEnd);
  }
  if (cursor < baseLines.length) out.push(...baseLines.slice(cursor));
  return out.join("\n");
}
