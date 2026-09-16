// 剧本编辑器虚拟滚动窗口的纯算术（#487 S6 从 ScriptEditor 的回调里抽出）。
// 这些函数只吃数组 / Map / 数字，不碰 DOM 和 ref；编辑器里的回调负责从 ref 取值、量 DOM，
// 然后把结果交给这里。窗口 / 垫片 / 当前场的算术一旦出错，表现是滚动跳变或目录高亮错场，
// 肉眼极难归因，所以单独钉住。
import type { Block } from "@/lib/script/script-types";

export type WindowRange = { start: number; end: number };

/** 把窗口夹进 [0, blockCount]，且至少含一块；空剧本为 [0, 0)。 */
export function clampWindowRange(range: WindowRange, blockCount: number): WindowRange {
  if (blockCount <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(range.start, blockCount - 1));
  const end = Math.max(start + 1, Math.min(range.end, blockCount));
  return { start, end };
}

/**
 * 累计高度表：cum[i] = 前 i 块的总高度（cum[0] = 0，长度 blocks.length + 1）。
 * 没量过的块用已量块的平均值——比固定默认值准得多；一块都没量过时用 defaultH。
 * hiddenBlockId（折叠的开场章节标记）按 0 高计。
 */
export function buildCumulativeHeights(
  blocks: readonly { id: string }[],
  measured: ReadonlyMap<string, number>,
  measuredTotal: number,
  hiddenBlockId: string | null | undefined,
  defaultH: number,
): number[] {
  const avgH = measured.size > 0 ? measuredTotal / measured.size : defaultH;
  const arr = new Array<number>(blocks.length + 1);
  arr[0] = 0;
  for (let i = 0; i < blocks.length; i++) {
    arr[i + 1] = arr[i] + (
      hiddenBlockId !== null && hiddenBlockId !== undefined && blocks[i].id === hiddenBlockId
        ? 0
        : measured.get(blocks[i].id) ?? avgH
    );
  }
  return arr;
}

/** 二分：顶边落在 offset 之后的第一块的索引（offset 超出总高时取最后一块）。 */
export function blockAtOffset(cum: readonly number[], offset: number): number {
  const n = cum.length - 1;
  if (n <= 0) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid + 1] <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 窗口两端的垫片高度；累计表还没建到那么长时按 defaultH 估。 */
export function spacerHeightsFor(
  cum: readonly number[], range: WindowRange, blockCount: number, defaultH: number,
): { top: number; bot: number } {
  const safeRange = clampWindowRange(range, blockCount);
  const top = cum[safeRange.start] ?? safeRange.start * defaultH;
  const total = cum[blockCount] ?? blockCount * defaultH;
  const bot = Math.max(0, total - (cum[safeRange.end] ?? safeRange.end * defaultH));
  return { top, bot };
}

/**
 * 给定块索引找它所属的场：章节 / 场次标记块自带 sceneId；正文块先看归属投影（owned），
 * 再看块自己的 sceneId；都没有就在前后 buffer 块内就近找。只认 sceneIds 里存在的场。
 */
export function resolveActiveSceneIdForBlockIndex(
  blocks: readonly Block[],
  owned: readonly { sceneId?: string | null }[],
  sceneIds: ReadonlySet<string>,
  index: number,
  buffer: number,
): string | null {
  if (blocks.length === 0 || sceneIds.size === 0) return null;

  const validSceneId = (id: string | null | undefined): string | null => (
    id && sceneIds.has(id) ? id : null
  );
  const sceneIdAt = (idx: number): string | null => {
    const block = blocks[idx];
    if (!block) return null;
    if ((block.type === "chapter_marker" || block.type === "scene_marker") && block.sceneId) {
      return validSceneId(block.sceneId);
    }
    return validSceneId(owned[idx]?.sceneId) ?? validSceneId(block.sceneId);
  };

  const safeIndex = Math.max(0, Math.min(index, blocks.length - 1));
  const direct = sceneIdAt(safeIndex);
  if (direct) return direct;

  const nearbyStart = Math.max(0, safeIndex - buffer);
  const nearbyEnd = Math.min(blocks.length - 1, safeIndex + buffer);
  for (let idx = safeIndex - 1; idx >= nearbyStart; idx--) {
    const sceneId = sceneIdAt(idx);
    if (sceneId) return sceneId;
  }
  for (let idx = safeIndex + 1; idx <= nearbyEnd; idx++) {
    const sceneId = sceneIdAt(idx);
    if (sceneId) return sceneId;
  }
  return null;
}

/**
 * 按可见首尾块算下一个窗口：两端离窗口边都还有 edgeThreshold 块余量就不动（返回 null）；
 * 否则前后各留 buffer 块，并把焦点块 / 待聚焦块硬包进来（它们在窗口外会丢焦点）。
 */
export function nextWindowRange(
  current: WindowRange,
  firstVisibleIdx: number,
  lastVisibleIdx: number,
  blockCount: number,
  buffer: number,
  mustInclude: readonly number[],
): WindowRange | null {
  const edgeThreshold = Math.max(40, Math.floor(buffer / 3));
  const hasEnoughHeadroom = firstVisibleIdx >= current.start + edgeThreshold;
  const hasEnoughFootroom = lastVisibleIdx <= current.end - edgeThreshold;
  if (hasEnoughHeadroom && hasEnoughFootroom) return null;

  let newStart = Math.max(0, firstVisibleIdx - buffer);
  let newEnd = Math.min(blockCount, lastVisibleIdx + buffer + 1);
  for (const idx of mustInclude) {
    if (idx >= 0) { newStart = Math.min(newStart, idx); newEnd = Math.max(newEnd, idx + 1); }
  }
  return { start: newStart, end: newEnd };
}
