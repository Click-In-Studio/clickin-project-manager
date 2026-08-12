import { describe, expect, it } from "vitest";
import { buildFinalImportMarkers } from "@/lib/import/final-markers";
import type { JointImportMappingRow } from "@/lib/import/types";

const rows: JointImportMappingRow[] = [
  {
    id: "chapter-a",
    extracted: { num: "00", name: "序章", parentNum: null },
    imported: null,
  },
  {
    id: "scene-a",
    extracted: { num: "00-4", name: "第一场", parentNum: "00" },
    imported: null,
  },
  {
    id: "chapter-b",
    extracted: { num: "8", name: "第二章", parentNum: null },
    imported: null,
  },
];

describe("buildFinalImportMarkers", () => {
  it("turns the first generated chapter into 0 开场", () => {
    expect(buildFinalImportMarkers(rows, true).map(item => item.marker)).toMatchObject([
      { num: "0", name: "开场", parentNum: null },
      { num: "0-1", name: "第一场", parentNum: "0" },
      { num: "1", name: "第二章", parentNum: null },
    ]);
  });

  it("keeps the first generated chapter as chapter 1", () => {
    expect(buildFinalImportMarkers(rows, false).map(item => item.marker)).toMatchObject([
      { num: "1", name: "序章", parentNum: null },
      { num: "1-1", name: "第一场", parentNum: "1" },
      { num: "2", name: "第二章", parentNum: null },
    ]);
  });
});
