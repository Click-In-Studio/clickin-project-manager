import { addSelectionRange, replaceSelectionItem, replaceSelectionRange, toggleSelectionItem, type SelectionState } from "@/lib/script/script-selection";
import { isMarkerBlock } from "@/lib/script/script-marker-blocks";
import type { Block } from "@/lib/script/script-types";

type SelectionSnapshot = SelectionState & { anchorId: string | null; detached: boolean; invalidEndIds: Set<string> };
type Modifiers = { shiftKey: boolean; additive: boolean };

export class ScriptSelection {
  private snapshot: SelectionSnapshot = { selectedIds: new Set(), markerEndIds: new Set(), anchorId: null, detached: false, invalidEndIds: new Set() };
  private listeners = new Set<() => void>();
  constructor(private readBlocks: () => Block[]) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private commit(next: SelectionState, anchorId = this.snapshot.anchorId, detached = this.snapshot.detached) {
    this.snapshot = { ...next, anchorId: next.selectedIds.size ? anchorId : null, detached: next.selectedIds.size ? detached : false, invalidEndIds: new Set() };
    for (const listener of this.listeners) listener();
  }
  clear = () => { this.commit({ selectedIds: new Set(), markerEndIds: new Set() }, null, false); };
  detach = () => { this.snapshot = { ...this.snapshot, detached: true }; };
  selectOne = (id: string) => {
    const blocks = this.readBlocks(), index = blocks.findIndex(block => block.id === id);
    this.commit(replaceSelectionItem(blocks, index, isMarkerBlock), id, false);
  };
  selectMoved = (ids: string[]) => {
    const selectedIds = new Set(ids), blocks = this.readBlocks();
    const last = blocks.filter(block => selectedIds.has(block.id)).at(-1);
    this.commit({ selectedIds, markerEndIds: last && isMarkerBlock(last) ? new Set([last.id]) : new Set() }, ids[0] ?? null, false);
  };
  remove = (ids: ReadonlySet<string>) => {
    const selectedIds = new Set([...this.snapshot.selectedIds].filter(id => !ids.has(id)));
    const blocks = this.readBlocks();
    const markerEndIds = new Set(blocks.filter((block, index) => selectedIds.has(block.id) && isMarkerBlock(block)
      && !selectedIds.has(blocks[index + 1]?.id)).map(block => block.id));
    this.commit({ selectedIds, markerEndIds }, this.snapshot.anchorId && ids.has(this.snapshot.anchorId) ? selectedIds.values().next().value ?? null : this.snapshot.anchorId, false);
  };
  reconcile = () => {
    const blocks = this.readBlocks(), ids = new Set(blocks.map(block => block.id));
    const selectedIds = new Set([...this.snapshot.selectedIds].filter(id => ids.has(id)));
    const markerEndIds = new Set(blocks.filter((block, index) => selectedIds.has(block.id) && isMarkerBlock(block)
      && !selectedIds.has(blocks[index + 1]?.id)).map(block => block.id));
    const anchorId = this.snapshot.anchorId && ids.has(this.snapshot.anchorId) ? this.snapshot.anchorId : selectedIds.values().next().value ?? null;
    if (selectedIds.size !== this.snapshot.selectedIds.size || anchorId !== this.snapshot.anchorId
      || markerEndIds.size !== this.snapshot.markerEndIds.size || [...markerEndIds].some(id => !this.snapshot.markerEndIds.has(id))) {
      this.commit({ selectedIds, markerEndIds }, anchorId);
    }
  };
  validate = (ids: string[]): boolean => {
    const invalidEndIds = ids.length > 1 ? new Set(this.snapshot.markerEndIds) : new Set<string>();
    this.snapshot = { ...this.snapshot, invalidEndIds };
    for (const listener of this.listeners) listener();
    return invalidEndIds.size === 0;
  };
  clickMarker = (id: string, modifiers: Modifiers) => {
    const blocks = this.readBlocks(), index = blocks.findIndex(block => block.id === id), current = this.snapshot;
    if (modifiers.shiftKey && current.selectedIds.size) { this.clear(); return; }
    if (modifiers.additive) {
      const next = toggleSelectionItem(blocks, current, index, isMarkerBlock);
      this.commit(next, next.selectedIds.has(id) ? id : next.selectedIds.values().next().value ?? null, true);
    } else if (current.selectedIds.has(id)) {
      const next = toggleSelectionItem(blocks, current, index, isMarkerBlock);
      this.commit(next, next.selectedIds.values().next().value ?? null);
    } else if (current.detached) {
      this.commit(replaceSelectionItem(blocks, index, isMarkerBlock), id);
    } else {
      this.commit(toggleSelectionItem(blocks, current, index, isMarkerBlock), id, true);
    }
  };
  clickText = (id: string, modifiers: Modifiers) => {
    const blocks = this.readBlocks(), index = blocks.findIndex(block => block.id === id), current = this.snapshot;
    if (modifiers.shiftKey) {
      const anchorIndex = blocks.findIndex(block => block.id === current.anchorId);
      const start = anchorIndex < 0 ? index : Math.min(anchorIndex, index), end = anchorIndex < 0 ? index : Math.max(anchorIndex, index);
      const next = modifiers.additive ? addSelectionRange(blocks, current, start, end, isMarkerBlock) : replaceSelectionRange(blocks, start, end, isMarkerBlock);
      this.commit(next, anchorIndex < 0 ? id : current.anchorId, true);
    } else if (!modifiers.additive && !current.selectedIds.has(id) && current.detached) {
      this.commit(replaceSelectionItem(blocks, index, isMarkerBlock), id, false);
    } else {
      const next = toggleSelectionItem(blocks, current, index, isMarkerBlock);
      this.commit(next, next.selectedIds.has(id) ? id : next.selectedIds.values().next().value ?? null, modifiers.additive || current.detached);
    }
  };
}
