import type { Block } from "@/lib/script/script-types";

export type DragTarget =
  | { kind: "block"; id: string; position: "before" | "after" }
  | { kind: "edge"; edge: "top" | "bottom" };
export type BlockDragTarget = Extract<DragTarget, { kind: "block" }>;

export function sameDragTarget(a: DragTarget | null, b: DragTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "edge" && b.kind === "edge") return a.edge === b.edge;
  if (a.kind === "block" && b.kind === "block") return a.id === b.id && a.position === b.position;
  return false;
}

export function resolveDragTarget(target: DragTarget, blocks: Block[], windowRange: { start: number; end: number }): BlockDragTarget | null {
  if (target.kind === "block") return target;
  if (blocks.length === 0) return null;
  const targetIdx = target.edge === "top"
    ? Math.min(windowRange.start, blocks.length - 1)
    : Math.max(0, Math.min(windowRange.end - 1, blocks.length - 1));
  const anchor = blocks[targetIdx];
  if (!anchor) return null;
  return { kind: "block", id: anchor.id, position: target.edge === "top" ? "before" : "after" };
}

export function getDragInsertIndex(target: BlockDragTarget, blocks: Block[]): number {
  const targetIdx = blocks.findIndex((b) => b.id === target.id);
  if (targetIdx === -1) return -1;
  return target.position === "before" ? targetIdx : targetIdx + 1;
}
