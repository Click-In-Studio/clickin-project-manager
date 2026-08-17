import type { Block, Character, Scene, ScriptState } from "./script-types";
import { isMarkerBlock, withLegacyOwnershipProjection } from "./script-marker-blocks";

// ─── Op types ─────────────────────────────────────────────────────────────────

/** A single tag entry carried inside a block op (keyed by logical block_id on the server). */
export type TagEntry = { groupId: string; optionId: string | null; value: number | null };

export type BlockOp =
  | { op: "insert"; block: Block; afterId: string | null; tags?: TagEntry[] }
  | { op: "update"; block: Block; tags?: TagEntry[] }
  | { op: "delete"; id: string }
  | { op: "reorder"; ids: string[]; movedIds?: string[] }; // full order plus the blocks actually moved

export type CharOp =
  | { op: "upsert"; char: Character }
  | { op: "delete"; id: string };

export type SceneOp =
  | { op: "upsert"; scene: Scene }
  | { op: "delete"; id: string }
  | { op: "reorder"; ids: string[] };

export type ScriptPatch = {
  clientSeq: number;       // monotonic counter from client; server ignores if stale
  blockOps: BlockOp[];
  charOps: CharOp[];
  sceneOps: SceneOp[];
};

function sameCharacterMetadata(a: Character, b: Character): boolean {
  return a.id === b.id && a.name === b.name && a.isAggregate === b.isAggregate;
}

// ─── diffState ────────────────────────────────────────────────────────────────

export function diffState(
  prev: ScriptState | null,
  curr: ScriptState,
  clientSeq: number
): ScriptPatch {
  const blockOps: BlockOp[] = [];
  const charOps: CharOp[] = [];
  const sceneOps: SceneOp[] = [];
  const projectedCurrBlocks = withLegacyOwnershipProjection(curr.blocks);

  if (prev === null) {
    // Full sync: treat everything as inserts / upserts
    let afterId: string | null = null;
    for (const block of projectedCurrBlocks) {
      blockOps.push({ op: "insert", block, afterId });
      afterId = block.id;
    }
    for (const char of curr.characters) {
      charOps.push({ op: "upsert", char });
    }
    for (const scene of curr.scenes) {
      sceneOps.push({ op: "upsert", scene });
    }
    return { clientSeq, blockOps, charOps, sceneOps };
  }

  const projectedPrevBlocks = withLegacyOwnershipProjection(prev.blocks);

  // ── Characters ──────────────────────────────────────────────────────────────
  const prevCharMap = new Map(prev.characters.map((c) => [c.id, c]));
  const currCharIds = new Set(curr.characters.map((c) => c.id));

  for (const char of curr.characters) {
    const old = prevCharMap.get(char.id);
    if (!old || !sameCharacterMetadata(old, char)) {
      charOps.push({ op: "upsert", char });
    }
  }
  for (const char of prev.characters) {
    if (!currCharIds.has(char.id)) {
      charOps.push({ op: "delete", id: char.id });
    }
  }

  // ── Scenes ───────────────────────────────────────────────────────────────────
  const prevSceneMap = new Map(prev.scenes.map((s) => [s.id, s]));
  const currSceneIds = new Set(curr.scenes.map((s) => s.id));

  for (const scene of curr.scenes) {
    const old = prevSceneMap.get(scene.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(scene)) {
      sceneOps.push({ op: "upsert", scene });
    }
  }
  for (const scene of prev.scenes) {
    if (!currSceneIds.has(scene.id)) {
      sceneOps.push({ op: "delete", id: scene.id });
    }
  }

  // Scene reorder detection. Compare the full current scene order, including
  // inserted scenes, so a newly inserted chapter/scene is persisted at its
  // local position instead of being appended by the server-side upsert path.
  const prevSceneOrder = prev.scenes.map((s) => s.id).join(",");
  const currSceneOrder = curr.scenes.map((s) => s.id).join(",");
  if (prevSceneOrder !== currSceneOrder) {
    sceneOps.push({ op: "reorder", ids: curr.scenes.map((s) => s.id) });
  }

  // ── Blocks ───────────────────────────────────────────────────────────────────
  const prevBlockMap = new Map(projectedPrevBlocks.map((b) => [b.id, b]));
  const currBlockMap = new Map(projectedCurrBlocks.map((b) => [b.id, b]));
  const currBlockIds = new Set(projectedCurrBlocks.map((b) => b.id));

  // Deletes
  for (const block of projectedPrevBlocks) {
    if (!currBlockIds.has(block.id)) {
      blockOps.push({ op: "delete", id: block.id });
    }
  }

  // Inserts
  for (let i = 0; i < projectedCurrBlocks.length; i++) {
    const block = projectedCurrBlocks[i];
    if (!prevBlockMap.has(block.id)) {
      const afterId = i > 0 ? projectedCurrBlocks[i - 1].id : null;
      blockOps.push({ op: "insert", block, afterId });
    }
  }

  // Updates (content/field changes on retained blocks)
  for (const block of projectedCurrBlocks) {
    const old = prevBlockMap.get(block.id);
    if (old && JSON.stringify(old) !== JSON.stringify(block)) {
      blockOps.push({ op: "update", block });
    }
  }

  // Reorder detection: compare relative order of blocks present in both states
  const retainedPrev = prev.blocks
    .filter((b) => currBlockIds.has(b.id))
    .map((b) => b.id);
  const retainedCurr = curr.blocks
    .filter((b) => currBlockMap.has(b.id) && prevBlockMap.has(b.id))
    .map((b) => b.id);

  if (retainedPrev.join(",") !== retainedCurr.join(",")) {
    blockOps.push({ op: "reorder", ids: curr.blocks.map((b) => b.id) });
  }

  return { clientSeq, blockOps, charOps, sceneOps };
}

export function patchAffectsMarkerProjection(patch: ScriptPatch, prevState: ScriptState): boolean {
  if (patch.sceneOps.length > 0) return true;
  if (patch.blockOps.length === 0) return false;
  const prevBlockById = new Map(prevState.blocks.map((block) => [block.id, block]));
  for (const op of patch.blockOps) {
    if (op.op === "insert" && isMarkerBlock(op.block)) return true;
    if (op.op === "delete") {
      const previous = prevBlockById.get(op.id);
      if (previous && isMarkerBlock(previous)) return true;
    }
    if (op.op === "update") {
      const previous = prevBlockById.get(op.block.id);
      if (previous?.type !== op.block.type) {
        if (isMarkerBlock(op.block) || !!previous && isMarkerBlock(previous)) return true;
      } else if (op.block.type === "chapter_marker" || op.block.type === "scene_marker") {
        return true;
      }
    }
    if (op.op === "reorder") {
      const previousOrder = prevState.blocks.filter(isMarkerBlock).map((block) => block.id);
      const nextOrder = op.ids.filter((id) => {
        const block = prevBlockById.get(id);
        return !!block && isMarkerBlock(block);
      });
      if (previousOrder.join(",") !== nextOrder.join(",")) return true;
    }
  }
  return false;
}

// ─── Permission classification ────────────────────────────────────────────────

// 批E2：needed 集合全节点化（node: 键统一走 hasGrant 行判定）
//
// scene 面逐字段（2026-08-17）：marker block 就是 scene 在剧本里的化身，改它的
// markerMeta 等同于在构作页改同名字段。原先无论增删改一律给 `scene/*@edit`
// 一把总钥匙，与 grant_template 的字段级键对不上（模板发 synopsis@edit，判定
// 却查 scene/*@edit，两边永不相交）。此处与 SCENE_FIELD_SUBS 逐键对应。
export type ScriptPermissionKey =
  | "node:script/*/blocks@edit"
  | "node:script/*/rehearsal_marks@create"
  | "node:character/*@edit"
  | "node:scene/*@create"
  | "node:scene/*@edit"
  | "node:scene/*@delete"
  | "node:scene/*/meta/name@edit"
  | "node:scene/*/meta/type@edit"
  | "node:scene/*/synopsis@edit"
  | "node:scene/*/action_line@edit"
  | "node:scene/*/music@edit"
  | "node:scene/*/stage_notes@edit"
  | "node:scene/*/meta/expected_duration@edit";

/** 保留旧名以免下游 import 断裂（判定端只消费键集合，不消费这个对象形态）。 */
export type ScriptPermissions = Record<ScriptPermissionKey, boolean>;

/** markerMeta 字段 → 节点键。与 app/api/production/[id]/scenes/[sceneId] 的
 *  SCENE_FIELD_SUBS 同源：同一个字段，两条写入路径要求同一把钥匙。 */
const MARKER_META_FIELD_KEYS: Record<string, ScriptPermissionKey> = {
  name: "node:scene/*/meta/name@edit",
  synopsis: "node:scene/*/synopsis@edit",
  actionLine: "node:scene/*/action_line@edit",
  music: "node:scene/*/music@edit",
  stageNotes: "node:scene/*/stage_notes@edit",
  expectedDuration: "node:scene/*/meta/expected_duration@edit",
};

function isSceneMarker(block: Block): boolean {
  return block.type === "chapter_marker" || block.type === "scene_marker";
}

/** marker 的存在性变化：插入=scene create，删除=scene delete。 */
function addMarkerLifecyclePermission(
  block: Block,
  verb: "create" | "delete",
  needed: Set<ScriptPermissionKey>,
): void {
  if (block.type === "rehearsal_marker") {
    needed.add("node:script/*/rehearsal_marks@create");
  } else if (isSceneMarker(block)) {
    needed.add(verb === "create" ? "node:scene/*@create" : "node:scene/*@delete");
  }
}

/** marker 的位置变化：scene 结构面（重排），不是字段写。 */
function addMarkerReorderPermission(block: Block, needed: Set<ScriptPermissionKey>): void {
  if (block.type === "rehearsal_marker") {
    needed.add("node:script/*/rehearsal_marks@create");
  } else if (isSceneMarker(block)) {
    needed.add("node:scene/*@edit");
  }
}

/** marker 的内容变化：逐字段比对，只要真正动了的字段的钥匙。 */
function addMarkerUpdatePermission(
  prev: Block,
  next: Block,
  needed: Set<ScriptPermissionKey>,
): void {
  if (prev.type === "rehearsal_marker" || next.type === "rehearsal_marker") {
    needed.add("node:script/*/rehearsal_marks@create");
    if (!isSceneMarker(prev) && !isSceneMarker(next)) return;
  }
  if (!isSceneMarker(prev) && !isSceneMarker(next)) return;

  // 章节 ↔ 场次转换
  if (prev.type !== next.type && isSceneMarker(prev) && isSceneMarker(next)) {
    needed.add("node:scene/*/meta/type@edit");
  }
  // marker block 的正文即标题
  if (prev.content !== next.content) needed.add("node:scene/*/meta/name@edit");

  const prevMeta = prev.markerMeta ?? {};
  const nextMeta = next.markerMeta ?? {};
  for (const [field, key] of Object.entries(MARKER_META_FIELD_KEYS)) {
    const before = (prevMeta as Record<string, unknown>)[field] ?? "";
    const after = (nextMeta as Record<string, unknown>)[field] ?? "";
    if (before !== after) needed.add(key);
  }
  // 归属改变 = 结构面
  if ((prevMeta.parentMarkerId ?? null) !== (nextMeta.parentMarkerId ?? null)) {
    needed.add("node:scene/*@edit");
  }
  if ((prevMeta.number ?? "") !== (nextMeta.number ?? "")) {
    // 场次号由 marker 顺序派生，没有独立的改号入口——号变即结构变
    needed.add("node:scene/*@edit");
  }
}

/**
 * Returns the set of script permissions required by a patch, given the current
 * server state (needed to diff block updates field-by-field).
 */
export function requiredPermissions(
  patch: ScriptPatch,
  prevState: ScriptState,
): Set<ScriptPermissionKey> {
  const needed = new Set<ScriptPermissionKey>();
  const prevBlockMap = new Map(prevState.blocks.map((b) => [b.id, b]));

  // 角色操作要的是角色权限——原先查 scene/*@edit 是复制残留
  if (patch.charOps.length > 0) needed.add("node:character/*@edit");

  // scene 明细行：改名走 meta/name@edit（与构作页 REST 同一把钥匙），号/归属
  // 变动才算结构面。若这里笼统给 scene/*@edit，改名就又需要结构钥匙——
  // 等于把总钥匙换了个名字。
  const prevSceneMap = new Map(prevState.scenes.map((s) => [s.id, s]));
  for (const op of patch.sceneOps) {
    if (op.op === "delete") { needed.add("node:scene/*@delete"); continue; }
    if (op.op === "reorder") { needed.add("node:scene/*@edit"); continue; }
    const old = prevSceneMap.get(op.scene.id);
    if (!old) { needed.add("node:scene/*@create"); continue; }
    if (old.name !== op.scene.name) needed.add("node:scene/*/meta/name@edit");
    if (old.number !== op.scene.number || (old.parentId ?? null) !== (op.scene.parentId ?? null)) {
      needed.add("node:scene/*@edit");
    }
  }

  for (const op of patch.blockOps) {
    if (op.op === "insert") {
      if (isMarkerBlock(op.block)) addMarkerLifecyclePermission(op.block, "create", needed);
      else needed.add("node:script/*/blocks@edit");
      continue;
    }
    if (op.op === "delete") {
      const old = prevBlockMap.get(op.id);
      if (old && isMarkerBlock(old)) addMarkerLifecyclePermission(old, "delete", needed);
      else needed.add("node:script/*/blocks@edit");
      continue;
    }
    if (op.op === "reorder") {
      const nextBlocks = op.ids.map((id) => prevBlockMap.get(id)).filter((block): block is Block => !!block);
      const prevIndexById = new Map(prevState.blocks.map((block, index) => [block.id, index]));
      const nextIndexById = new Map(op.ids.map((id, index) => [id, index]));
      const prevTextOrder = prevState.blocks.filter((block) => !isMarkerBlock(block)).map((block) => block.id).join(",");
      const nextTextOrder = nextBlocks.filter((block) => !isMarkerBlock(block)).map((block) => block.id).join(",");
      if (prevTextOrder !== nextTextOrder) needed.add("node:script/*/blocks@edit");
      for (const block of nextBlocks) {
        if (isMarkerBlock(block) && prevIndexById.get(block.id) !== nextIndexById.get(block.id)) {
          addMarkerReorderPermission(block, needed);
        }
      }
      continue;
    }

    // op === "update" — diff against previous block to see what changed
    const old = prevBlockMap.get(op.block.id);
    if (!old) { needed.add("node:script/*/blocks@edit"); continue; }

    if (isMarkerBlock(op.block) || isMarkerBlock(old)) {
      // marker ↔ 正文块的互转会同时改变剧本正文构成
      if (op.block.type !== old.type && (!isMarkerBlock(op.block) || !isMarkerBlock(old))) {
        needed.add("node:script/*/blocks@edit");
        addMarkerLifecyclePermission(isMarkerBlock(old) ? old : op.block,
          isMarkerBlock(old) ? "delete" : "create", needed);
        continue;
      }
      addMarkerUpdatePermission(old, op.block, needed);
      continue;
    }

    if (
      op.block.content !== old.content ||
      (op.block.stageComment ?? "") !== (old.stageComment ?? "") ||
      op.block.type !== old.type ||
      op.block.lyric !== old.lyric ||
      (op.block.forceShowCharacterName ?? false) !== (old.forceShowCharacterName ?? false) ||
      JSON.stringify(op.block.characterIds) !== JSON.stringify(old.characterIds)
    ) needed.add("node:script/*/blocks@edit");
    if (op.block.rehearsalMark !== old.rehearsalMark) needed.add("node:script/*/rehearsal_marks@create");
    if (op.block.sceneId !== old.sceneId) needed.add("node:scene/*@edit");
  }

  return needed;
}
