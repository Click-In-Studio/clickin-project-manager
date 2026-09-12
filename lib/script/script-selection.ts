type SelectionItem = {
  id: string;
};

export type SelectionState = {
  selectedIds: Set<string>;
  markerEndIds: Set<string>;
};

function refreshEndpoint<T extends SelectionItem>(
  items: T[],
  selectedIds: Set<string>,
  markerEndIds: Set<string>,
  index: number,
  isMarker: (item: T) => boolean,
) {
  if (index < 0 || index >= items.length) return;
  const item = items[index];
  markerEndIds.delete(item.id);
  if (
    isMarker(item) &&
    selectedIds.has(item.id) &&
    (index === items.length - 1 || !selectedIds.has(items[index + 1].id))
  ) {
    markerEndIds.add(item.id);
  }
}

export function toggleSelectionItem<T extends SelectionItem>(
  items: T[],
  current: SelectionState,
  index: number,
  isMarker: (item: T) => boolean,
): SelectionState {
  const item = items[index];
  if (!item) return current;

  const selectedIds = new Set(current.selectedIds);
  const markerEndIds = new Set(current.markerEndIds);
  if (selectedIds.has(item.id)) selectedIds.delete(item.id);
  else selectedIds.add(item.id);

  refreshEndpoint(items, selectedIds, markerEndIds, index - 1, isMarker);
  refreshEndpoint(items, selectedIds, markerEndIds, index, isMarker);
  return { selectedIds, markerEndIds };
}

export function replaceSelectionRange<T extends SelectionItem>(
  items: T[],
  start: number,
  end: number,
  isMarker: (item: T) => boolean,
): SelectionState {
  const selectedIds = new Set<string>();
  for (let index = start; index <= end; index++) {
    const item = items[index];
    if (item) selectedIds.add(item.id);
  }
  const markerEndIds = new Set<string>();
  refreshEndpoint(items, selectedIds, markerEndIds, end, isMarker);
  return { selectedIds, markerEndIds };
}

export function addSelectionRange<T extends SelectionItem>(
  items: T[],
  current: SelectionState,
  start: number,
  end: number,
  isMarker: (item: T) => boolean,
): SelectionState {
  const selectedIds = new Set(current.selectedIds);
  const markerEndIds = new Set(current.markerEndIds);
  for (let index = start; index <= end; index++) {
    const item = items[index];
    if (!item) continue;
    selectedIds.add(item.id);
    markerEndIds.delete(item.id);
  }
  refreshEndpoint(items, selectedIds, markerEndIds, start - 1, isMarker);
  refreshEndpoint(items, selectedIds, markerEndIds, end, isMarker);
  return { selectedIds, markerEndIds };
}

export function replaceSelectionItem<T extends SelectionItem>(
  items: T[],
  index: number,
  isMarker: (item: T) => boolean,
): SelectionState {
  return replaceSelectionRange(items, index, index, isMarker);
}
