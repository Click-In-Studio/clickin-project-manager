import type { Block, Character, Scene, ScriptState } from "./script-types";
import type { ScriptPatch, TagEntry } from "./script-ops";
import { cleanMarkerMeta, toDbType } from "./script-row-model";
import { withLegacyOwnershipProjection } from "./script-marker-blocks";

/** 只传本批涉及的旧值；结构操作另带旧顺序，不保存历史版本。 */
export type ScriptPatchBasis = {
  blocks: Record<string, Block | null>;
  tags: Record<string, TagEntry[]>;
  characters: Record<string, Character | null>;
  scenes: Record<string, Scene | null>;
  blockOrder?: string[];
  sceneOrder?: string[];
};

export class ScriptPatchConflict extends Error {
  constructor() { super("SCRIPT_PATCH_CONFLICT"); }
}

export function buildScriptPatchBasis(
  baseline: ScriptState,
  patch: ScriptPatch,
  tags: ReadonlyMap<string, TagEntry[]>,
): ScriptPatchBasis {
  const blocks = new Map(withLegacyOwnershipProjection(baseline.blocks).map(b => [b.id, b]));
  const characters = new Map(baseline.characters.map(c => [c.id, c]));
  const scenes = new Map(baseline.scenes.map(s => [s.id, s]));
  const basis: ScriptPatchBasis = { blocks: {}, tags: {}, characters: {}, scenes: {} };
  for (const op of patch.blockOps) {
    if (op.op === "reorder") continue;
    const id = op.op === "delete" ? op.id : op.block.id;
    basis.blocks[id] = blocks.get(id) ?? null;
    if (op.op === "delete" || op.tags !== undefined) basis.tags[id] = tags.get(id) ?? [];
  }
  for (const op of patch.charOps) {
    const id = op.op === "delete" ? op.id : op.char.id;
    basis.characters[id] = characters.get(id) ?? null;
  }
  for (const op of patch.sceneOps) {
    if (op.op === "reorder") continue;
    const id = op.op === "delete" ? op.id : op.scene.id;
    basis.scenes[id] = scenes.get(id) ?? null;
  }
  if (patch.blockOps.some(op => op.op !== "update")) basis.blockOrder = baseline.blocks.map(b => b.id);
  if (patch.sceneOps.some(op => op.op === "reorder")) basis.sceneOrder = baseline.scenes.map(s => s.id);
  return basis;
}

// 比较真正写入的整块字段；JSON 键顺序、空注释与缺省值不制造假冲突。
function blockValue(b: Block | null | undefined): unknown {
  if (!b) return null;
  const meta = cleanMarkerMeta(b.markerMeta);
  return [b.id, toDbType(b), b.content, b.stageComment?.trim() || null,
    b.forceShowCharacterName ?? false, b.sceneId ?? null,
    ...(["name", "parentMarkerId", "synopsis", "actionLine", "music", "stageNotes", "expectedDuration"] as const).map(k => meta[k] ?? null),
    b.characterIds.map(id => [id, b.characterAnnotations[id] || null])];
}
function characterValue(c: Character | null | undefined): unknown {
  return c ? [c.id, c.name, c.isAggregate] : null;
}
function sceneValue(s: Scene | null | undefined): unknown {
  return s ? [s.id, s.name, s.parentId] : null;
}
function tagValue(tags: TagEntry[]): unknown {
  return tags.map(t => [t.groupId, t.optionId ?? null, t.value ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function requireBasis<T>(values: Record<string, T>, id: string): T {
  if (!Object.hasOwn(values, id)) throw new ScriptPatchConflict();
  return values[id];
}

/** 在事务锁内调用：先检查整批，冲突不做任何写入；已达到目标的操作不再执行。 */
export function conditionScriptPatch(
  patch: ScriptPatch,
  basis: ScriptPatchBasis,
  current: Pick<ScriptState, "blocks" | "characters" | "scenes">,
  currentTags: ReadonlyMap<string, TagEntry[]>,
  blockOrder: string[],
): ScriptPatch {
  const blocks = new Map(current.blocks.map(b => [b.id, b]));
  const chars = new Map(current.characters.map(c => [c.id, c]));
  const scenes = new Map(current.scenes.map(s => [s.id, s]));
  const blockOps = patch.blockOps.filter(op => {
    if (op.op === "reorder") return !equal(blockOrder, op.ids);
    const id = op.op === "delete" ? op.id : op.block.id;
    const old = requireBasis(basis.blocks, id);
    const now = blocks.get(id) ?? null;
    const target = op.op === "delete" ? null : op.block;
    const tags = currentTags.get(id) ?? [];
    const targetTags = op.op === "delete" ? [] : op.tags;
    const bodyDone = equal(blockValue(now), blockValue(target));
    const tagsDone = targetTags === undefined || equal(tagValue(tags), tagValue(targetTags));
    if (bodyDone && tagsDone) return false;
    if (!bodyDone && !equal(blockValue(now), blockValue(old))) throw new ScriptPatchConflict();
    // 删除包含标签，不允许删掉别人刚加的标签；已删则上面直接判成功。
    if (targetTags !== undefined && !tagsDone &&
      !equal(tagValue(tags), tagValue(requireBasis(basis.tags, id)))) throw new ScriptPatchConflict();
    if (op.op === "delete" && !equal(tagValue(tags), tagValue(requireBasis(basis.tags, id)))) throw new ScriptPatchConflict();
    return true;
  });
  const charOps = patch.charOps.filter(op => {
    const id = op.op === "delete" ? op.id : op.char.id;
    const old = requireBasis(basis.characters, id);
    const now = chars.get(id) ?? null;
    const target = op.op === "delete" ? null : op.char;
    if (equal(characterValue(now), characterValue(target))) return false;
    if (!equal(characterValue(now), characterValue(old))) throw new ScriptPatchConflict();
    return true;
  });
  const sceneOps = patch.sceneOps.filter(op => {
    if (op.op === "reorder") return !equal(current.scenes.map(s => s.id), op.ids);
    const id = op.op === "delete" ? op.id : op.scene.id;
    const old = requireBasis(basis.scenes, id);
    const now = scenes.get(id) ?? null;
    const target = op.op === "delete" ? null : op.scene;
    if (equal(sceneValue(now), sceneValue(target))) return false;
    if (!equal(sceneValue(now), sceneValue(old))) throw new ScriptPatchConflict();
    return true;
  });
  if (blockOps.some(op => op.op !== "update")) {
    if (!basis.blockOrder || !equal(blockOrder, basis.blockOrder)) throw new ScriptPatchConflict();
  }
  if (sceneOps.some(op => op.op === "reorder")) {
    if (!basis.sceneOrder || !equal(current.scenes.map(s => s.id), basis.sceneOrder)) throw new ScriptPatchConflict();
  }
  return { ...patch, blockOps, charOps, sceneOps };
}
