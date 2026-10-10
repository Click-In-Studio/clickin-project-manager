import { diffState, type ScriptPatch, type TagEntry } from "@/lib/script/script-ops";
import { buildScriptPatchBasis, type ScriptPatchBasis } from "@/lib/script/script-patch-basis";
import { isMarkerBlock } from "@/lib/script/script-marker-blocks";
import { normalizeScriptBlockStream } from "@/lib/script/script-block-stream";
import type { BlockTagValue } from "@/lib/script/script-block-tag-db";
import type { ScriptState } from "@/lib/script/script-types";

export type ScriptSaveBatch = {
  state: ScriptState;
  tags: Map<string, BlockTagValue[]>;
  patch: ScriptPatch;
  basis: ScriptPatchBasis;
  moved: Map<string, number>;
  structureChanged: boolean;
};

/** 冻结本次提交的内容与依据；请求期间的新编辑不属于这笔确认。 */
export function buildScriptSaveBatch(
  baseline: ScriptState,
  baselineTags: ReadonlyMap<string, BlockTagValue[]>,
  current: ScriptState,
  currentTags: ReadonlyMap<string, BlockTagValue[]>,
  moved: ReadonlyMap<string, number>,
  clientSeq: number,
): ScriptSaveBatch {
  const state = { ...current, blocks: normalizeScriptBlockStream(current.blocks) };
  const tags = new Map(currentTags);
  const patch = diffState({ ...baseline, blocks: normalizeScriptBlockStream(baseline.blocks) }, state, clientSeq);
  const reorder = patch.blockOps.find(op => op.op === "reorder");
  if (reorder?.op === "reorder" && moved.size) reorder.movedIds = [...moved.keys()];
  const deleted = new Set(patch.blockOps.flatMap(op => op.op === "delete" ? [op.id] : []));
  const blocks = new Map(state.blocks.map(block => [block.id, block]));
  for (const id of new Set([...tags.keys(), ...baselineTags.keys()])) {
    if (deleted.has(id) || !blocks.has(id)) continue;
    const values = tags.get(id) ?? [];
    if (JSON.stringify(values) === JSON.stringify(baselineTags.get(id) ?? [])) continue;
    const entries: TagEntry[] = values.map(({ groupId, optionId, value }) => ({ groupId, optionId, value }));
    const op = patch.blockOps.find(op => (op.op === "insert" || op.op === "update") && op.block.id === id);
    if (op?.op === "insert" || op?.op === "update") op.tags = entries;
    else patch.blockOps.push({ op: "update", block: blocks.get(id)!, tags: entries });
  }
  // 新块的继承标签与正文同步进入同一批，不依赖 React effect 的镜像更新时机。
  for (const op of patch.blockOps) {
    if (op.op === "insert" && tags.has(op.block.id)) {
      op.tags = tags.get(op.block.id)!.map(({ groupId, optionId, value }) => ({ groupId, optionId, value }));
    }
  }
  const oldBlocks = new Map(baseline.blocks.map(block => [block.id, block]));
  const structureChanged = patch.blockOps.some(op => {
    if (op.op !== "update") return true;
    const old = oldBlocks.get(op.block.id);
    return !old || old.type !== op.block.type || isMarkerBlock(old) || isMarkerBlock(op.block);
  });
  return {
    state, tags, patch, moved: new Map(moved), structureChanged,
    basis: buildScriptPatchBasis(baseline, patch, baselineTags),
  };
}

export function hasScriptSaveOperations(batch: ScriptSaveBatch): boolean {
  return Boolean(batch.patch.blockOps.length || batch.patch.charOps.length || batch.patch.sceneOps.length);
}
