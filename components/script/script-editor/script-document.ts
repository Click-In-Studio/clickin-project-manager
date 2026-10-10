import type { BlockTagValue, TagGroup } from "@/lib/script/script-block-tag-db";
import type { SceneDetail } from "@/lib/script/script-scene-character-db";
import { expandLegacyMarkersToBlocks, makeBlock, normalizeScriptMarkerInvariants, sameBlocks } from "@/lib/script/script-block-stream";
import { buildMarkerContextById, isMarkerBlock, withLegacyOwnershipProjection } from "@/lib/script/script-marker-blocks";
import { getMarkerChange, markerCacheUpdateBlockIds, type MarkerChange } from "@/lib/script/script-marker-domain";
import { buildMarkerLabelIndex } from "@/lib/script/script-generated-labels";
import { updateMarkerOwnership } from "@/lib/script/script-marker-ownership-cache";
import { updateEstimatedPageMap, type EstimatedPageMapCache } from "@/lib/script/script-page";
import { computeLyricFromTags, syncSceneDetailsWithScenes, type SceneMetaFields } from "@/lib/script/script-scene-details";
import { buildScriptPatchBasis } from "@/lib/script/script-patch-basis";
import { DEFAULT_SCRIPT_CONFIG, type Block, type Character, type ScriptConfig, type ScriptState } from "@/lib/script/script-types";
import type { ScriptWindowBootstrap, ScriptWindowResponse } from "@/lib/script/script-window-types";
import { confirmScriptSave } from "./script-document-confirm";
import { bootstrapBlocks, mergeScriptDocument, tagsToMap } from "./script-document-merge";
import { buildScriptSaveBatch, hasScriptSaveOperations, type ScriptSaveBatch } from "./script-save-batch";

type Update<T> = T | ((previous: T) => T);
const value = <T,>(update: Update<T>, previous: T): T => typeof update === "function" ? (update as (p: T) => T)(previous) : update;

export type ScriptDocumentSnapshot = ScriptState & {
  tags: Map<string, BlockTagValue[]>;
  tagGroups: TagGroup[];
  sceneDetails: SceneDetail[];
  loadedIds: Set<string>;
  manifestIds: Set<string>;
  orderRevision: string;
  serverPageMap: Record<string, number> | null;
  ownedBlocks: Block[];
  markerContextById: ReturnType<typeof buildMarkerContextById>;
  legacyProjectedBlocks: Block[];
  rehearsalLabels: ReturnType<typeof buildMarkerLabelIndex>;
  blockIndexById: Map<string, number>;
  sceneIdSet: Set<string>;
  pageMap: Record<string, number>;
};

/** 正文与它的已同步依据在这里共同更新；外部只提交编辑或服务器结果。 */
export class ScriptDocument {
  private snapshot: ScriptDocumentSnapshot;
  private baseline: ScriptState | null;
  private baselineTags = new Map<string, BlockTagValue[]>();
  private moved = new Map<string, number>();
  private moveSequence = 0;
  private pageCache: EstimatedPageMapCache | null = null;
  private listeners = new Set<() => void>();

  constructor(bootstrap?: ScriptWindowBootstrap | null) {
    const blocks = bootstrap ? bootstrapBlocks(bootstrap) : [makeBlock()];
    const state: ScriptState = {
      blocks, characters: bootstrap?.characters ?? [], scenes: bootstrap?.scenes ?? [],
      config: bootstrap?.config ?? DEFAULT_SCRIPT_CONFIG,
    };
    this.baseline = bootstrap ? state : null;
    this.baselineTags = tagsToMap(bootstrap?.window.tags ?? []);
    this.snapshot = this.derive({
      ...state, tags: this.baselineTags, tagGroups: bootstrap?.tagGroups ?? [], sceneDetails: [],
      loadedIds: new Set(bootstrap?.window.blocks.map(block => block.id) ?? blocks.map(block => block.id)),
      manifestIds: new Set(bootstrap?.manifest.map(block => block.id) ?? []),
      orderRevision: bootstrap?.orderRevision ?? "", serverPageMap: bootstrap?.pageMap ?? null,
    });
  }

  getSnapshot = (): ScriptDocumentSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  read = (): ScriptState => ({ blocks: this.snapshot.blocks, characters: this.snapshot.characters, scenes: this.snapshot.scenes, config: this.snapshot.config });

  private derive(input: Omit<ScriptDocumentSnapshot, "ownedBlocks" | "markerContextById" | "legacyProjectedBlocks" | "rehearsalLabels" | "blockIndexById" | "sceneIdSet" | "pageMap">): ScriptDocumentSnapshot {
    const old = this.snapshot;
    const blocksChanged = !old || old.blocks !== input.blocks;
    const change = old && blocksChanged ? getMarkerChange(old.blocks, input.blocks) : null;
    const blockIndexById = blocksChanged ? new Map(input.blocks.map((block, i) => [block.id, i])) : old.blockIndexById;
    const dirtyOwnership = change ? markerCacheUpdateBlockIds(input.blocks, change).flatMap(id => {
      const start = blockIndexById.get(id);
      return start === undefined ? [] : [{ start, end: start + 1, throughNextMarker: false }];
    }) : "full" as const;
    const ownedBlocks = blocksChanged ? updateMarkerOwnership(input.blocks, dirtyOwnership) : old.ownedBlocks;
    const markerContextById = blocksChanged ? buildMarkerContextById(ownedBlocks) : old.markerContextById;
    const structureChanged = !old || change?.markerStructureChanged;
    let pageMap = input.serverPageMap;
    if (!pageMap && old && !blocksChanged && old.config.pageLayout === input.config.pageLayout
      && old.config.textLayoutMode === input.config.textLayoutMode && old.config.templateId === input.config.templateId) pageMap = old.pageMap;
    if (!pageMap) {
      this.pageCache = updateEstimatedPageMap(this.pageCache, ownedBlocks, input.config.pageLayout,
        input.config.textLayoutMode, true, old ? null : "full", input.config.templateId ?? null);
      pageMap = this.pageCache.pageMap;
    }
    return {
      ...input, ownedBlocks, markerContextById,
      tags: [...input.tags.keys()].every(id => blockIndexById.has(id)) ? input.tags : new Map([...input.tags].filter(([id]) => blockIndexById.has(id))),
      loadedIds: [...input.loadedIds].every(id => blockIndexById.has(id)) ? input.loadedIds : new Set([...input.loadedIds].filter(id => blockIndexById.has(id))),
      legacyProjectedBlocks: blocksChanged ? withLegacyOwnershipProjection(ownedBlocks, markerContextById) : old.legacyProjectedBlocks,
      rehearsalLabels: structureChanged ? buildMarkerLabelIndex(input.blocks) : old.rehearsalLabels,
      blockIndexById,
      sceneIdSet: !old || old.scenes !== input.scenes ? new Set(input.scenes.map(scene => scene.id)) : old.sceneIdSet,
      pageMap,
    };
  }

  private commit(update: Partial<ScriptDocumentSnapshot>) {
    const next = { ...this.snapshot, ...update };
    if (update.scenes) next.sceneDetails = syncSceneDetailsWithScenes(update.sceneDetails ?? next.sceneDetails, update.scenes);
    this.snapshot = this.derive(next);
    for (const listener of this.listeners) listener();
  }

  editBlocks = (update: Update<Block[]>) => {
    const blocks = value(update, this.snapshot.blocks);
    const loadedIds = new Set(this.snapshot.loadedIds);
    for (const block of blocks) if (!this.snapshot.manifestIds.has(block.id)) loadedIds.add(block.id);
    const openingChapterMarkerId = blocks.find(block => block.type === "chapter_marker")?.id ?? null;
    const config = openingChapterMarkerId === this.snapshot.config.openingChapterMarkerId
      ? this.snapshot.config : { ...this.snapshot.config, openingChapterMarkerId };
    this.commit({ blocks, loadedIds, config });
  };

  editStructure = (next: ScriptState, movedIds: Iterable<string> = []) => {
    for (const id of movedIds) this.moved.set(id, ++this.moveSequence);
    const loadedIds = new Set(this.snapshot.loadedIds);
    for (const block of next.blocks) if (!this.snapshot.manifestIds.has(block.id)) loadedIds.add(block.id);
    this.commit({ ...next, loadedIds });
  };

  editBlockStructure = (blocks: Block[], change?: MarkerChange) => {
    const next = normalizeScriptMarkerInvariants(blocks, this.snapshot.scenes, this.snapshot.config, change);
    this.editStructure({ ...this.read(), ...next });
  };
  editCharacters = (update: Update<Character[]>) => { this.commit({ characters: value(update, this.snapshot.characters) }); };
  removeCharacter = (id: string) => {
    const blocks = this.snapshot.blocks.map(block => {
      if (!block.characterIds.includes(id) && !(id in block.characterAnnotations)) return block;
      const characterAnnotations = { ...block.characterAnnotations };
      delete characterAnnotations[id];
      return { ...block, characterIds: block.characterIds.filter(characterId => characterId !== id), characterAnnotations };
    });
    this.commit({ blocks, characters: this.snapshot.characters.filter(character => character.id !== id) });
  };
  editConfig = (update: Update<ScriptConfig>) => { this.commit({ config: value(update, this.snapshot.config) }); };
  editSceneDetails = (update: Update<SceneDetail[]>) => { this.commit({ sceneDetails: syncSceneDetailsWithScenes(value(update, this.snapshot.sceneDetails), this.snapshot.scenes) }); };
  patchSceneDetails = (id: string, fields: Partial<SceneMetaFields>) => {
    this.editSceneDetails(previous => previous.map(scene => scene.id === id ? { ...scene, ...fields } : scene));
  };
  setPageMap = (serverPageMap: Record<string, number>) => { this.commit({ serverPageMap }); };

  editTag = (blockId: string, groupId: string, optionId: string | null, tagValue: number | null, remove: boolean) => {
    const tags = this.snapshot.tags.get(blockId) ?? [];
    const next = tags.filter(tag => tag.groupId !== groupId);
    if (!remove) next.push({ blockId, groupId, optionId, value: tagValue });
    const group = this.snapshot.tagGroups.find(group => group.id === groupId);
    const hasSplitRule = group?.options.some(option => option.id === group.lyricSplitAfterOptionId);
    this.putTags(blockId, next, Boolean(hasSplitRule), Boolean(hasSplitRule));
  };
  pasteTags = (blockId: string, tags: BlockTagValue[]) => { this.putTags(blockId, tags.map(tag => ({ ...tag, blockId })), false); };
  inheritTags = (fromId: string, toId: string) => {
    const tags = this.snapshot.tags.get(fromId) ?? [];
    if (tags.length) this.putTags(toId, tags.map(tag => ({ ...tag, blockId: toId })), true);
  };
  private putTags(blockId: string, values: BlockTagValue[], updateLyric: boolean, clearMissingLyric = false) {
    const tags = new Map(this.snapshot.tags);
    tags.set(blockId, values);
    const lyric = updateLyric ? (computeLyricFromTags(values, this.snapshot.tagGroups) ?? (clearMissingLyric ? false : null)) : null;
    const blocks = lyric === null ? this.snapshot.blocks : this.snapshot.blocks.map(block => block.id === blockId ? { ...block, lyric } : block);
    this.commit({ tags, blocks });
  }

  editTagGroups = (tagGroups: TagGroup[]) => { this.commit({ tagGroups }); };

  loadTags = (groups: TagGroup[], tags: BlockTagValue[]) => {
    const map = tagsToMap(tags);
    this.baselineTags = map;
    this.commit({ tagGroups: groups, tags: map });
  };

  replaceServer = (state: ScriptState) => {
    const expanded = expandLegacyMarkersToBlocks(state.blocks, state.scenes);
    const normalized = normalizeScriptMarkerInvariants(expanded, state.scenes, { ...DEFAULT_SCRIPT_CONFIG, ...state.config });
    this.baseline = { ...state, ...normalized };
    this.moved.clear();
    this.commit({ ...this.baseline, loadedIds: new Set(normalized.blocks.map(block => block.id)) });
  };

  applyBootstrap = (bootstrap: ScriptWindowBootstrap, replace = false) => {
    const server = { blocks: bootstrapBlocks(bootstrap), characters: bootstrap.characters, scenes: bootstrap.scenes, config: bootstrap.config };
    const tags = tagsToMap(bootstrap.window.tags);
    const merged = !replace && this.baseline
      ? mergeScriptDocument(this.read(), server, this.baseline, this.snapshot.tags, tags, this.baselineTags)
      : { current: server, baseline: server, tags, baselineTags: tags };
    this.baseline = merged.baseline;
    this.baselineTags = merged.baselineTags;
    if (replace) this.moved.clear();
    const loadedIds = new Set(bootstrap.window.blocks.map(block => block.id));
    const old = new Map(this.snapshot.blocks.map(block => [block.id, block]));
    for (const block of merged.current.blocks) {
      if (block === old.get(block.id) && this.snapshot.loadedIds.has(block.id)) loadedIds.add(block.id);
    }
    this.commit({
      ...merged.current, tags: merged.tags, tagGroups: bootstrap.tagGroups, loadedIds,
      manifestIds: new Set(bootstrap.manifest.map(block => block.id)), orderRevision: bootstrap.orderRevision,
      serverPageMap: bootstrap.pageMap,
    });
  };

  mergeWindow = (body: ScriptWindowResponse): boolean => {
    if (!this.baseline || body.orderRevision !== this.snapshot.orderRevision) return false;
    const blocks = [...this.snapshot.blocks], baselineBlocks = [...this.baseline.blocks];
    const tags = new Map(this.snapshot.tags), baselineTags = new Map(this.baselineTags);
    const serverTags = tagsToMap(body.window.tags), loadedIds = new Set(this.snapshot.loadedIds);
    for (let offset = 0; offset < body.window.blocks.length; offset++) {
      const index = body.window.start + offset, server = body.window.blocks[offset];
      if (blocks[index]?.id !== server.id || baselineBlocks[index]?.id !== server.id) return false;
      if (sameBlocks([blocks[index]], [baselineBlocks[index]])) blocks[index] = baselineBlocks[index] = server;
      if (JSON.stringify(tags.get(server.id) ?? []) === JSON.stringify(baselineTags.get(server.id) ?? [])) {
        const values = serverTags.get(server.id) ?? [];
        if (values.length) { tags.set(server.id, values); baselineTags.set(server.id, values); }
        else { tags.delete(server.id); baselineTags.delete(server.id); }
      }
      loadedIds.add(server.id);
    }
    this.baseline = { ...this.baseline, blocks: baselineBlocks };
    this.baselineTags = baselineTags;
    this.commit({ blocks, tags, loadedIds });
    return true;
  };

  mergeServer = (server: ScriptState) => {
    if (!this.baseline) { this.replaceServer(server); return; }
    const merged = mergeScriptDocument(this.read(), server, this.baseline, this.snapshot.tags, new Map(this.baselineTags), this.baselineTags);
    this.baseline = merged.baseline;
    this.baselineTags = merged.baselineTags;
    this.commit({ ...merged.current, tags: merged.tags });
  };

  prepareSave = (seq: number): ScriptSaveBatch | null => {
    if (!this.baseline) return null;
    const batch = buildScriptSaveBatch(this.baseline, this.baselineTags, this.read(), this.snapshot.tags, this.moved, seq);
    // 骨架只能参加结构顺序，不能作为整块正文 update 上传。
    batch.patch.blockOps = batch.patch.blockOps.filter(op => op.op !== "update" || isMarkerBlock(op.block)
      || !this.snapshot.manifestIds.has(op.block.id) || this.snapshot.loadedIds.has(op.block.id));
    batch.basis = buildScriptPatchBasis(this.baseline, batch.patch, this.baselineTags);
    return batch;
  };
  hasPending = (): boolean => {
    const batch = this.prepareSave(0);
    return batch !== null && hasScriptSaveOperations(batch);
  };
  acknowledge = (batch: ScriptSaveBatch) => {
    if (!this.baseline) return;
    const confirmed = confirmScriptSave(this.baseline, this.baselineTags, batch);
    this.baseline = confirmed.baseline;
    this.baselineTags = confirmed.tags;
    for (const [id, sequence] of batch.moved) if (this.moved.get(id) === sequence) this.moved.delete(id);
  };
  beginLoading = () => {
    this.baseline = null;
    this.moved.clear();
    this.pageCache = null;
    this.commit({ blocks: [makeBlock()], characters: [], scenes: [], sceneDetails: [], loadedIds: new Set() });
  };
}
