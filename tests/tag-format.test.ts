import { describe, expect, it } from "vitest";
import { buildImportFormatOptionIds, buildImportTagFormatLookup, mergeVisibleTagOptionOrder } from "@/lib/import/tag-format";
import type { ImportTagChanges } from "@/lib/import/types";

const emptyChanges = (): ImportTagChanges => ({
  createGroups: [],
  createOptions: [],
  updateGroups: [],
  updateOptions: [],
  deleteGroupIds: [],
  deleteOptionIds: [],
});

describe("buildImportTagFormatLookup", () => {
  it("uses the persisted format boundary", () => {
    const lookup = buildImportTagFormatLookup([{
      id: "group-1",
      type: "exclusive",
      lyricSplitAfterOptionId: "option-2",
      options: [
        { id: "option-1", sortOrder: 0 },
        { id: "option-2", sortOrder: 1 },
        { id: "option-3", sortOrder: 2 },
      ],
    }]);

    expect(lookup.lyricSplitBoundary.get("group-1")).toBe(1);
    expect(lookup.optionSortOrderMap.get("group-1:option-3")).toBe(2);
  });

  it("applies a draft boundary to a draft option", () => {
    const changes = emptyChanges();
    changes.createGroups.push({ clientId: "new-group", name: "格式" });
    changes.createOptions.push(
      { clientId: "new-option-1", groupId: "new-group", label: "唱", color: "#a1a1aa", sortOrder: 0 },
      { clientId: "new-option-2", groupId: "new-group", label: "说", color: "#a1a1aa", sortOrder: 1 },
    );
    changes.updateGroups.push({ groupId: "new-group", lyricSplitAfterOptionId: "new-option-1" });

    const lookup = buildImportTagFormatLookup([], changes);

    expect(lookup.lyricSplitBoundary.get("new-group")).toBe(0);
    expect(lookup.optionSortOrderMap.get("new-group:new-option-2")).toBe(1);
  });

  it("clears a persisted boundary in the draft without changing range groups", () => {
    const changes = emptyChanges();
    changes.updateGroups.push({ groupId: "exclusive", lyricSplitAfterOptionId: null });
    const lookup = buildImportTagFormatLookup([
      {
        id: "exclusive",
        type: "exclusive",
        lyricSplitAfterOptionId: "exclusive-option",
        options: [{ id: "exclusive-option", sortOrder: 0 }],
      },
      {
        id: "range",
        type: "range",
        lyricSplitAfterOptionId: "range-option",
        options: [{ id: "range-option", sortOrder: 0 }],
      },
    ], changes);

    expect(lookup.lyricSplitBoundary.has("exclusive")).toBe(false);
    expect(lookup.lyricSplitBoundary.has("range")).toBe(false);
    expect(lookup.optionSortOrderMap.has("range:range-option")).toBe(false);
  });

  it("uses draft option order when resolving the format boundary", () => {
    const changes = emptyChanges();
    changes.updateOptions.push(
      { groupId: "group-1", optionId: "option-1", sortOrder: 2 },
      { groupId: "group-1", optionId: "option-2", sortOrder: 0 },
      { groupId: "group-1", optionId: "option-3", sortOrder: 1 },
    );
    const lookup = buildImportTagFormatLookup([{
      id: "group-1",
      type: "exclusive",
      lyricSplitAfterOptionId: "option-2",
      options: [
        { id: "option-1", sortOrder: 0 },
        { id: "option-2", sortOrder: 1 },
        { id: "option-3", sortOrder: 2 },
      ],
    }], changes);

    expect(lookup.lyricSplitBoundary.get("group-1")).toBe(0);
    expect(lookup.optionSortOrderMap.get("group-1:option-1")).toBe(2);
  });
});

describe("mergeVisibleTagOptionOrder", () => {
  it("reorders selected options without removing or moving hidden options", () => {
    const options = [
      { id: "selected-a", label: "A", sortOrder: 0 },
      { id: "hidden-x", label: "X", sortOrder: 1 },
      { id: "selected-b", label: "B", sortOrder: 2 },
      { id: "hidden-y", label: "Y", sortOrder: 3 },
      { id: "selected-c", label: "C", sortOrder: 4 },
    ];

    const reordered = mergeVisibleTagOptionOrder(options, [
      { id: "selected-c" },
      { id: "selected-a" },
      { id: "selected-b" },
    ]);

    expect(reordered.map(option => option.id)).toEqual([
      "selected-c",
      "hidden-x",
      "selected-a",
      "hidden-y",
      "selected-b",
    ]);
    expect(reordered.map(option => option.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("buildImportFormatOptionIds", () => {
  it("includes selected options and newly created draft options only", () => {
    const optionIds = buildImportFormatOptionIds(
      [{ groupId: "tone", optionId: "selected-tone" }],
      [{ groupId: "tone", clientId: "draft-tone" }, { groupId: "rhythm", clientId: "draft-rhythm" }],
    );

    expect([...optionIds.get("tone")!]).toEqual(["selected-tone", "draft-tone"]);
    expect([...optionIds.get("rhythm")!]).toEqual(["draft-rhythm"]);
    expect(optionIds.get("tone")?.has("persisted-unselected-tone")).toBe(false);
  });
});
