import type { ImportTagChanges } from "./types";

type FormatOption = {
  id: string;
  sortOrder: number;
};

type FormatGroup = {
  id: string;
  type: "exclusive" | "range";
  lyricSplitAfterOptionId: string | null;
  options: FormatOption[];
};

export function buildImportFormatOptionIds(
  selectedOptions: Array<{ groupId: string; optionId: string }>,
  createdOptions: Array<{ groupId: string; clientId: string }>,
): Map<string, Set<string>> {
  const optionIdsByGroup = new Map<string, Set<string>>();
  for (const option of selectedOptions) {
    const optionIds = optionIdsByGroup.get(option.groupId) ?? new Set<string>();
    optionIds.add(option.optionId);
    optionIdsByGroup.set(option.groupId, optionIds);
  }
  for (const option of createdOptions) {
    const optionIds = optionIdsByGroup.get(option.groupId) ?? new Set<string>();
    optionIds.add(option.clientId);
    optionIdsByGroup.set(option.groupId, optionIds);
  }
  return optionIdsByGroup;
}

export function mergeVisibleTagOptionOrder<T extends { id: string; sortOrder: number }>(
  allOptions: T[],
  orderedVisibleOptions: Array<{ id: string }>,
): T[] {
  const sorted = [...allOptions].sort((a, b) => a.sortOrder - b.sortOrder);
  const optionById = new Map(sorted.map(option => [option.id, option]));
  const reorderedVisible = orderedVisibleOptions
    .map(option => optionById.get(option.id))
    .filter((option): option is T => !!option);
  const visibleIds = new Set(reorderedVisible.map(option => option.id));
  let visibleIndex = 0;
  return sorted.map(option => (
    visibleIds.has(option.id) ? reorderedVisible[visibleIndex++] : option
  )).map((option, sortOrder) => ({ ...option, sortOrder }));
}

export function buildImportTagFormatLookup(
  sourceGroups: FormatGroup[],
  changes?: ImportTagChanges,
) {
  const groups = sourceGroups.map(group => ({
    ...group,
    options: group.options.map(option => ({ ...option })),
  }));

  for (const group of changes?.createGroups ?? []) {
    groups.push({
      id: group.clientId,
      type: "exclusive",
      lyricSplitAfterOptionId: null,
      options: [],
    });
  }
  for (const option of changes?.createOptions ?? []) {
    const group = groups.find(item => item.id === option.groupId);
    group?.options.push({ id: option.clientId, sortOrder: option.sortOrder });
  }
  for (const update of changes?.updateOptions ?? []) {
    const option = groups
      .find(group => group.id === update.groupId)
      ?.options.find(item => item.id === update.optionId);
    if (option && update.sortOrder !== undefined) option.sortOrder = update.sortOrder;
  }
  for (const update of changes?.updateGroups ?? []) {
    const group = groups.find(item => item.id === update.groupId);
    if (group && update.lyricSplitAfterOptionId !== undefined) {
      group.lyricSplitAfterOptionId = update.lyricSplitAfterOptionId;
    }
  }

  const deletedGroupIds = new Set(changes?.deleteGroupIds ?? []);
  const deletedOptionIds = new Set(changes?.deleteOptionIds ?? []);
  const lyricSplitBoundary = new Map<string, number>();
  const optionSortOrderMap = new Map<string, number>();
  for (const group of groups) {
    if (deletedGroupIds.has(group.id) || group.type !== "exclusive") continue;
    const options = group.options.filter(option => !deletedOptionIds.has(option.id));
    for (const option of options) {
      optionSortOrderMap.set(`${group.id}:${option.id}`, option.sortOrder);
    }
    if (!group.lyricSplitAfterOptionId) continue;
    const splitOption = options.find(option => option.id === group.lyricSplitAfterOptionId);
    if (splitOption) lyricSplitBoundary.set(group.id, splitOption.sortOrder);
  }

  return { lyricSplitBoundary, optionSortOrderMap };
}
