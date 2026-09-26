import { describe, expect, it } from "vitest";
import { mergeLines } from "@/lib/editor/line-merge";
import { tableMergeUnits } from "@/lib/editor/table-merge";
import { htmlTableToMarkdown } from "@/lib/editor/table-html";
import { richTableProblems, richTableRanges } from "@/lib/editor/table-dialect";
const base = htmlTableToMarkdown('<table><tr><td>甲</td><td>乙</td></tr></table>')!;
describe("表格三路合并", () => {
  for (const source of [base, `前\n\n${base}\n\n尾\n`, `\n${base}\n`, "\n\n", "", base + "\n\n" + base]) {
    it("合并单元保持原文与尾部换行", () => expect(tableMergeUnits(source).join("\n")).toBe(source));
  }
  it("不同格的修改同时保留", () => {
    const merged = mergeLines(base, base.replace("甲", "甲改"), base.replace("乙", "乙改"));
    expect(merged).toBe(base.replace("甲", "甲改").replace("乙", "乙改"));
  });
  it("同格并发修改保留两份完整表格", () => {
    const merged = mergeLines(base, base.replace("甲", "甲改"), base.replace("甲", "甲另一版"));
    expect(richTableRanges(merged)).toHaveLength(2);
    expect(richTableProblems(merged)).toEqual([]);
    expect(merged).toContain("甲改");
    expect(merged).toContain("甲另一版");
  });
  it("删除整表与改格冲突不丢对方表格", () => {
    const merged = mergeLines(base, "", base.replace("甲", "甲改"));
    expect(merged).toContain("甲改");
    expect(richTableProblems(merged)).toEqual([]);
  });
  it("改网格与改格冲突保留两个合法网格", () => {
    const other = htmlTableToMarkdown('<table><tr><td colspan="2">合并后</td></tr></table>')!;
    const merged = mergeLines(base, other, base.replace("甲", "甲改"));
    expect(richTableRanges(merged)).toHaveLength(2);
    expect(richTableProblems(merged)).toEqual([]);
  });
});
