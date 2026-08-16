import { FIXED_INITIAL_CHAPTER_NAME } from "@/lib/script-fixed-markers";

export function shouldImportFirstChapterAsOpening(chapterNumber: string, chapterName: string): boolean {
  const normalizedNumber = chapterNumber.trim();
  if (normalizedNumber === "") return false;
  const numericNumber = Number(normalizedNumber);
  const normalizedName = chapterName.trim();
  return Number.isFinite(numericNumber) && numericNumber === 0 &&
    (normalizedName === "" || normalizedName === FIXED_INITIAL_CHAPTER_NAME);
}
