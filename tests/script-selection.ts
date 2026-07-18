import assert from "node:assert/strict";
import {
  addSelectionRange,
  replaceSelectionRange,
  toggleSelectionItem,
  type SelectionState,
} from "../lib/script-selection";

type Item = { id: string; isMarker: boolean };

const items: Item[] = [
  { id: "m0", isMarker: true },
  { id: "s1", isMarker: false },
  { id: "m2", isMarker: true },
  { id: "s3", isMarker: false },
  { id: "m4", isMarker: true },
];
const isMarker = (item: Item) => item.isMarker;

const empty = (): SelectionState => ({ selectedIds: new Set(), markerEndIds: new Set() });
const ids = (values: Set<string>) => [...values].sort();

const singleMarker = toggleSelectionItem(items, empty(), 0, isMarker);
assert.deepEqual(ids(singleMarker.selectedIds), ["m0"]);
assert.deepEqual(ids(singleMarker.markerEndIds), ["m0"]);

const markerThenScript = toggleSelectionItem(items, singleMarker, 1, isMarker);
assert.deepEqual(ids(markerThenScript.selectedIds), ["m0", "s1"]);
assert.deepEqual(ids(markerThenScript.markerEndIds), []);

const isolatedScript = toggleSelectionItem(items, singleMarker, 3, isMarker);
assert.deepEqual(ids(isolatedScript.markerEndIds), ["m0"]);

const twoMarkerEndedScopes = toggleSelectionItem(items, isolatedScript, 4, isMarker);
assert.deepEqual(ids(twoMarkerEndedScopes.markerEndIds), ["m0", "m4"]);

const bridged = addSelectionRange(items, twoMarkerEndedScopes, 1, 3, isMarker);
assert.deepEqual(ids(bridged.selectedIds), ["m0", "m2", "m4", "s1", "s3"]);
assert.deepEqual(ids(bridged.markerEndIds), ["m4"]);

const validRange = replaceSelectionRange(items, 0, 3, isMarker);
assert.deepEqual(ids(validRange.markerEndIds), []);

const markerEndedRange = replaceSelectionRange(items, 1, 2, isMarker);
assert.deepEqual(ids(markerEndedRange.markerEndIds), ["m2"]);

const splitAtScript = toggleSelectionItem(items, validRange, 1, isMarker);
assert.deepEqual(ids(splitAtScript.markerEndIds), ["m0"]);

const removeInteriorMarker = toggleSelectionItem(items, validRange, 2, isMarker);
assert.deepEqual(ids(removeInteriorMarker.markerEndIds), []);

function expectedMarkerEnds(selectedIds: Set<string>): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (
      item.isMarker &&
      selectedIds.has(item.id) &&
      (index === items.length - 1 || !selectedIds.has(items[index + 1].id))
    ) {
      result.add(item.id);
    }
  }
  return result;
}

for (let mask = 0; mask < 1 << items.length; mask++) {
  const selectedIds = new Set(items.filter((_, index) => mask & (1 << index)).map((item) => item.id));
  const state = { selectedIds, markerEndIds: expectedMarkerEnds(selectedIds) };

  for (let index = 0; index < items.length; index++) {
    const toggled = toggleSelectionItem(items, state, index, isMarker);
    assert.deepEqual(ids(toggled.markerEndIds), ids(expectedMarkerEnds(toggled.selectedIds)));
  }

  for (let start = 0; start < items.length; start++) {
    for (let end = start; end < items.length; end++) {
      const added = addSelectionRange(items, state, start, end, isMarker);
      assert.deepEqual(ids(added.markerEndIds), ids(expectedMarkerEnds(added.selectedIds)));

      const replaced = replaceSelectionRange(items, start, end, isMarker);
      assert.deepEqual(ids(replaced.markerEndIds), ids(expectedMarkerEnds(replaced.selectedIds)));
    }
  }
}

console.log("script selection tests passed");
