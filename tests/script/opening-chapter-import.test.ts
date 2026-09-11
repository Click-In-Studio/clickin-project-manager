import { describe, expect, it } from "vitest";
import { shouldImportFirstChapterAsOpening } from "@/lib/import/opening-chapter";

describe("shouldImportFirstChapterAsOpening", () => {
  it.each(["0", "00", "000", " 00 "])(
    "treats numeric-zero chapter number %j as opening when the name is empty or 开场",
    chapterNumber => {
      expect(shouldImportFirstChapterAsOpening(chapterNumber, "")).toBe(true);
      expect(shouldImportFirstChapterAsOpening(chapterNumber, "开场")).toBe(true);
    },
  );

  it("requires both a numeric-zero number and an opening-compatible name", () => {
    expect(shouldImportFirstChapterAsOpening("0", "序章")).toBe(false);
    expect(shouldImportFirstChapterAsOpening("1", "开场")).toBe(false);
    expect(shouldImportFirstChapterAsOpening("", "开场")).toBe(false);
  });
});
