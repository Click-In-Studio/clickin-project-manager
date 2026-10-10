import type { BlockTagValue } from "@/lib/script/script-block-tag-db";
import type { ScriptState } from "@/lib/script/script-types";
import type { ScriptSaveBatch } from "./script-save-batch";

/** 只确认已发送的操作，保留在途期间由窗口加载补齐的未修改正文。 */
export function confirmScriptSave(baseline: ScriptState, baselineTags: Map<string, BlockTagValue[]>, batch: ScriptSaveBatch) {
  let blocks = [...baseline.blocks], characters = [...baseline.characters], scenes = [...baseline.scenes];
  const tags = new Map(baselineTags);
  const savedBlocks = new Map(batch.state.blocks.map(block => [block.id, block]));
  for (const op of batch.patch.blockOps) {
    if (op.op === "delete") { blocks = blocks.filter(block => block.id !== op.id); tags.delete(op.id); }
    else if (op.op === "reorder") {
      const rows = new Map(blocks.map(block => [block.id, block]));
      const ids = new Set(op.ids);
      blocks = [...op.ids.flatMap(id => rows.has(id) ? [rows.get(id)!] : []), ...blocks.filter(block => !ids.has(block.id))];
    } else {
      const row = savedBlocks.get(op.block.id)!;
      const index = blocks.findIndex(block => block.id === row.id);
      if (index >= 0) blocks[index] = row;
      else if (op.op === "insert") blocks.splice(op.afterId === null ? 0 : blocks.findIndex(block => block.id === op.afterId) + 1, 0, row);
      if (op.tags) tags.set(row.id, batch.tags.get(row.id) ?? []);
    }
  }
  for (const op of batch.patch.charOps) {
    if (op.op === "delete") characters = characters.filter(row => row.id !== op.id);
    else {
      const index = characters.findIndex(row => row.id === op.char.id);
      if (index < 0) characters.push(op.char); else characters[index] = op.char;
    }
  }
  for (const op of batch.patch.sceneOps) {
    if (op.op === "delete") scenes = scenes.filter(row => row.id !== op.id);
    else if (op.op === "reorder") {
      const rows = new Map(scenes.map(row => [row.id, row]));
      const ids = new Set(op.ids);
      scenes = [...op.ids.flatMap(id => rows.has(id) ? [rows.get(id)!] : []), ...scenes.filter(row => !ids.has(row.id))];
    } else {
      const index = scenes.findIndex(row => row.id === op.scene.id);
      if (index < 0) scenes.push(op.scene); else scenes[index] = op.scene;
    }
  }
  return { baseline: { ...baseline, blocks, characters, scenes }, tags };
}
