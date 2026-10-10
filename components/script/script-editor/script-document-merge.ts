import { sameBlocks } from "@/lib/script/script-block-stream";
import type { BlockTagValue } from "@/lib/script/script-block-tag-db";
import type { Block, ScriptState } from "@/lib/script/script-types";
import { manifestEntryToSkeleton, type ScriptWindowBootstrap } from "@/lib/script/script-window-types";

export function bootstrapBlocks(bootstrap?: ScriptWindowBootstrap | null): Block[] {
  if (!bootstrap) return [];
  const blocks = bootstrap.manifest.map(manifestEntryToSkeleton);
  bootstrap.window.blocks.forEach((block, offset) => { blocks[bootstrap.window.start + offset] = block; });
  return blocks;
}

export function tagsToMap(tags: readonly BlockTagValue[]): Map<string, BlockTagValue[]> {
  const result = new Map<string, BlockTagValue[]>();
  for (const tag of tags) result.set(tag.blockId, [...(result.get(tag.blockId) ?? []), tag]);
  return result;
}

function mergeRows<T extends { id: string }>(
  local: T[], server: T[], old: T[], equal: (a: T, b: T) => boolean,
) {
  const oldById = new Map(old.map(row => [row.id, row]));
  const localById = new Map(local.map(row => [row.id, row]));
  const serverById = new Map(server.map(row => [row.id, row]));
  const orderDirty = local.length !== old.length || local.some((row, i) => row.id !== old[i]?.id);
  const dirty = (row: T) => !oldById.has(row.id) || !equal(row, oldById.get(row.id)!);
  const current = orderDirty
    ? [...local.map(row => dirty(row) ? row : serverById.get(row.id) ?? row),
      ...server.filter(row => !oldById.has(row.id) && !localById.has(row.id))]
    : [...server.map(row => localById.has(row.id) && dirty(localById.get(row.id)!) ? localById.get(row.id)! : row),
      ...local.filter(row => !serverById.has(row.id) && dirty(row))];
  // 本地结构尚未提交时保留旧顺序依据，远端结构变化由条件保存裁决，不能静默消掉本地操作。
  const basisRows = orderDirty ? [...old, ...server.filter(row => !oldById.has(row.id))] : server;
  const baseline = [...basisRows, ...old.filter(row => !basisRows.some(basis => basis.id === row.id) && localById.has(row.id) && dirty(localById.get(row.id)!))].map(row => {
    const localRow = localById.get(row.id);
    return localRow && dirty(localRow) ? oldById.get(row.id) ?? row : serverById.get(row.id) ?? row;
  });
  return { current, baseline };
}

/** 刷新服务器内容时，本地脏内容与它的旧依据一起保留。 */
export function mergeScriptDocument(
  local: ScriptState, server: ScriptState, old: ScriptState,
  localTags: ReadonlyMap<string, BlockTagValue[]>, serverTags: Map<string, BlockTagValue[]>,
  oldTags: ReadonlyMap<string, BlockTagValue[]>,
) {
  const blocks = mergeRows(local.blocks, server.blocks, old.blocks, (a, b) => sameBlocks([a], [b]));
  const equal = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  const characters = mergeRows(local.characters, server.characters, old.characters, equal);
  const scenes = mergeRows(local.scenes, server.scenes, old.scenes, equal);
  const tags = new Map(serverTags);
  const baselineTags = new Map(serverTags);
  for (const id of new Set([...localTags.keys(), ...oldTags.keys()])) {
    const values = localTags.get(id) ?? [];
    const baseline = oldTags.get(id) ?? [];
    if (!equal(values, baseline)) {
      tags.set(id, values);
      baselineTags.set(id, baseline);
    }
  }
  return {
    current: { blocks: blocks.current, characters: characters.current, scenes: scenes.current, config: server.config },
    baseline: { blocks: blocks.baseline, characters: characters.baseline, scenes: scenes.baseline, config: server.config },
    tags, baselineTags,
  };
}
