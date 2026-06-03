import type { Block, Character, Scene, ScriptState } from "./script-types";

// ─── Op types ─────────────────────────────────────────────────────────────────

export type BlockOp =
  | { op: "insert"; block: Block; afterId: string | null }
  | { op: "update"; block: Block }
  | { op: "delete"; id: string }
  | { op: "reorder"; ids: string[] }; // full ordered id list of retained blocks

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

// ─── diffState ────────────────────────────────────────────────────────────────

export function diffState(
  prev: ScriptState | null,
  curr: ScriptState,
  clientSeq: number
): ScriptPatch {
  const blockOps: BlockOp[] = [];
  const charOps: CharOp[] = [];
  const sceneOps: SceneOp[] = [];

  if (prev === null) {
    // Full sync: treat everything as inserts / upserts
    let afterId: string | null = null;
    for (const block of curr.blocks) {
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

  // ── Characters ──────────────────────────────────────────────────────────────
  const prevCharMap = new Map(prev.characters.map((c) => [c.id, c]));
  const currCharIds = new Set(curr.characters.map((c) => c.id));

  for (const char of curr.characters) {
    const old = prevCharMap.get(char.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(char)) {
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

  // Scene reorder detection
  const retainedPrevScenes = prev.scenes.filter((s) => currSceneIds.has(s.id)).map((s) => s.id);
  const retainedCurrScenes = curr.scenes.filter((s) => prevSceneMap.has(s.id)).map((s) => s.id);
  if (retainedPrevScenes.join(",") !== retainedCurrScenes.join(",")) {
    sceneOps.push({ op: "reorder", ids: curr.scenes.map((s) => s.id) });
  }

  // ── Blocks ───────────────────────────────────────────────────────────────────
  const prevBlockMap = new Map(prev.blocks.map((b) => [b.id, b]));
  const currBlockMap = new Map(curr.blocks.map((b) => [b.id, b]));
  const currBlockIds = new Set(curr.blocks.map((b) => b.id));

  // Deletes
  for (const block of prev.blocks) {
    if (!currBlockIds.has(block.id)) {
      blockOps.push({ op: "delete", id: block.id });
    }
  }

  // Inserts
  for (let i = 0; i < curr.blocks.length; i++) {
    const block = curr.blocks[i];
    if (!prevBlockMap.has(block.id)) {
      const afterId = i > 0 ? curr.blocks[i - 1].id : null;
      blockOps.push({ op: "insert", block, afterId });
    }
  }

  // Updates (content/field changes on retained blocks)
  for (const block of curr.blocks) {
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

// ─── Permission classification ────────────────────────────────────────────────

export type ScriptPermissions = {
  "script:edit": boolean;
  "script:metadata": boolean;
  "script:rehearsal_mark": boolean;
};

/**
 * Returns the set of script permissions required by a patch, given the current
 * server state (needed to diff block updates field-by-field).
 */
export function requiredPermissions(
  patch: ScriptPatch,
  prevState: ScriptState,
): Set<keyof ScriptPermissions> {
  const needed = new Set<keyof ScriptPermissions>();
  const prevBlockMap = new Map(prevState.blocks.map((b) => [b.id, b]));

  if (patch.charOps.length > 0) needed.add("script:metadata");
  if (patch.sceneOps.some((op) => op.op === "upsert" || op.op === "delete" || op.op === "reorder")) needed.add("script:metadata");

  for (const op of patch.blockOps) {
    if (op.op === "insert" || op.op === "delete" || op.op === "reorder") {
      needed.add("script:edit");
      continue;
    }
    // op === "update" — diff against previous block to see what changed
    const old = prevBlockMap.get(op.block.id);
    if (!old) { needed.add("script:edit"); continue; }

    if (
      op.block.content !== old.content ||
      op.block.type !== old.type ||
      op.block.lyric !== old.lyric ||
      (op.block.forceShowCharacterName ?? false) !== (old.forceShowCharacterName ?? false) ||
      JSON.stringify(op.block.characterIds) !== JSON.stringify(old.characterIds)
    ) needed.add("script:edit");
    if (op.block.rehearsalMark !== old.rehearsalMark) needed.add("script:rehearsal_mark");
    if (op.block.sceneId !== old.sceneId) needed.add("script:metadata");
  }

  return needed;
}
