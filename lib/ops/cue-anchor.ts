import type { Cue, CueAnchor } from "@/lib/ops/cue-types";

export function isPointCue(cue: Cue): boolean {
  if (cue.start.kind !== cue.end.kind) return false;
  if (cue.start.kind === "gap" && cue.end.kind === "gap")
    return cue.start.afterBlockId === cue.end.afterBlockId;
  if (cue.start.kind === "block" && cue.end.kind === "block")
    return cue.start.blockId === cue.end.blockId && cue.start.offset === cue.end.offset;
  return false;
}

export function anchorEq(a: CueAnchor, b: CueAnchor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "gap" && b.kind === "gap") return a.afterBlockId === b.afterBlockId;
  if (a.kind === "block" && b.kind === "block")
    return a.blockId === b.blockId && a.offset === b.offset;
  return false;
}

// Linear sort key: gap after block i sits between block i and block i+1.
export function anchorSortKey(anchor: CueAnchor, blockIndexMap: Map<string, number>): number {
  if (anchor.kind === "gap") {
    const i = anchor.afterBlockId !== null ? (blockIndexMap.get(anchor.afterBlockId) ?? -1) : -1;
    return (i + 1) * 1_000_000;
  }
  const i = blockIndexMap.get(anchor.blockId) ?? -1;
  return i * 1_000_000 + anchor.offset + 1;
}
