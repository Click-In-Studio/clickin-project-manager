/**
 * 估算器几何的直接单测（docs/script-template-engine.md §3）。
 *
 * script-template-legacy.test.ts 钉的是「与旧实现逐字节相同」——那是集成层面的。这里把
 * 列宽分配与单块高度拆开逐条钉：fr / rem / px / auto 混排、列间距、行折叠、侧栏标签
 * 贯穿全行、inline 前缀吃首行、场次标题至少一行、以及两个 legacy 专用开关的作用面。
 * 新模版（百老汇等）靠的是这些几何，而不是 legacy 的 quirk。
 */
import { describe, it, expect } from "vitest";
import type { Block } from "@/lib/script-types";
import { columnWidths, estimateItemHeight, planBlock, planSceneHeading } from "@/lib/script-template";
import type { BlockStyle, ScriptTemplate, TextStyle, EstimateOptions } from "@/lib/script-template";
import { LEGACY_CENTER } from "@/lib/script-template/presets/legacy";

const BODY: TextStyle = { face: "script", fontSize: 14, lineHeight: 28 };
const NAME: TextStyle = { face: "script", fontSize: 14, lineHeight: 20, weight: "bold" };
const EXACT: EstimateOptions = { countGapBefore: true };

function block(over: Partial<Block> = {}): Block {
  return {
    id: "b1", type: "dialogue", content: "", characterIds: [], characterAnnotations: {},
    lyric: false, sceneId: "s1", rehearsalMark: null, ...over,
  };
}

/** 用给定的对白样式造一个模版（其余沿用 legacy-center），规则清空以便只测几何 */
function templateWith(dialogue: BlockStyle): ScriptTemplate {
  return { ...LEGACY_CENTER, id: "t", rules: [], estimate: EXACT, blockStyles: { ...LEGACY_CENTER.blockStyles, dialogue } };
}

function heightOf(style: BlockStyle, b: Block, contentWidth = 644, options: EstimateOptions = EXACT): number {
  const template = templateWith(style);
  const item = planBlock(b, null, {
    template, characters: [{ id: "c1", name: "林晚", isAggregate: false }], scenes: [], stageDelimOpen: "（", stageDelimClose: "）",
  });
  return estimateItemHeight(item, "normal", contentWidth, options);
}

describe("columnWidths", () => {
  it("fr 列平分「总宽 − 固定列 − 列间距」", () => {
    expect(columnWidths({ columns: [{ width: "7.5rem" }, { width: "1rem" }, { width: "1fr" }], gapX: 8 }, 644))
      .toEqual([120, 16, 644 - 120 - 16 - 16]);
  });
  it("多个 fr 按权重分；px 直接用", () => {
    expect(columnWidths({ columns: [{ width: "100px" }, { width: "1fr" }, { width: "3fr" }], gapX: 0 }, 500))
      .toEqual([100, 100, 300]);
  });
  it("auto 列按调用方给的 max-content 宽算，其余给 fr", () => {
    expect(columnWidths({ columns: [{ width: "auto" }, { width: "1fr" }], gapX: 10 }, 400, [70, 0]))
      .toEqual([70, 320]);
  });
  it("固定列超过总宽时 fr 列为 0，不出负数", () => {
    expect(columnWidths({ columns: [{ width: "500px" }, { width: "1fr" }], gapX: 0 }, 300)).toEqual([500, 0]);
  });
});

describe("estimateItemHeight：单列", () => {
  const single: BlockStyle = {
    frame: { columns: [{ width: "1fr" }], gapX: 0 },
    padding: { top: 4, bottom: 4 },
    slots: [
      { id: "character", field: "character", box: { col: 1, row: 1 }, style: NAME, marginBottom: 2, hideIfEmpty: true },
      { id: "content", field: "content", box: { col: 1, row: 2 }, style: BODY, hideIfEmpty: false },
    ],
  };

  it("空正文占一行；无角色时角色名槽整行消失", () => {
    expect(heightOf(single, block())).toBe(28 + 8);
  });
  it("有角色：角色名一行（行高 + 下外边距）+ 正文", () => {
    expect(heightOf(single, block({ characterIds: ["c1"] }))).toBe(22 + 28 + 8);
  });
  it("正文按「列宽 / 字号」个全角单位换行；拉丁字母算半个", () => {
    const upl = Math.floor(644 / 14); // 46
    expect(heightOf(single, block({ content: "中".repeat(upl) }))).toBe(28 + 8);
    expect(heightOf(single, block({ content: "中".repeat(upl + 1) }))).toBe(56 + 8);
    expect(heightOf(single, block({ content: "a".repeat(upl * 2) }))).toBe(28 + 8);
    expect(heightOf(single, block({ content: "a".repeat(upl * 2 + 1) }))).toBe(56 + 8);
  });
  it("正文里的换行各自起段", () => {
    expect(heightOf(single, block({ content: "一\n二\n三" }))).toBe(84 + 8);
  });
});

describe("estimateItemHeight：网格", () => {
  const grid: BlockStyle = {
    frame: { columns: [{ width: "7.5rem" }, { width: "1rem" }, { width: "1fr" }], gapX: 8 },
    padding: { top: 0, bottom: 0 },
    slots: [
      { id: "character", field: "character", box: { col: 1, row: 1, rowSpan: "all" }, style: { ...NAME, lineHeight: 28 }, hideIfEmpty: true },
      { id: "stageComment", field: "stageComment", box: { col: 3, row: 1 }, style: BODY, hideIfEmpty: true, requireCharacters: true },
      { id: "content", field: "content", box: { col: 3, row: 2 }, style: BODY, hideIfEmpty: false },
    ],
  };

  it("正文列宽 = 总宽 − 固定列 − 间距（换行点随之前移）", () => {
    const upl = Math.floor((644 - 152) / 14); // 35
    expect(heightOf(grid, block({ content: "中".repeat(upl) }))).toBe(28);
    expect(heightOf(grid, block({ content: "中".repeat(upl + 1) }))).toBe(56);
  });
  it("侧栏角色名贯穿全行：与各行之和取大，不另占一行", () => {
    expect(heightOf(grid, block({ characterIds: ["c1"] }))).toBe(28);
    // 角色名本身两行（超长名字）时它撑高整块
    const long = templateWith(grid);
    const item = planBlock(block({ characterIds: ["c1"] }), null, {
      template: long, characters: [{ id: "c1", name: "林".repeat(20), isAggregate: false }], scenes: [], stageDelimOpen: "（", stageDelimClose: "）",
    });
    expect(estimateItemHeight(item, "normal", 644, EXACT)).toBe(28 * 3);
  });
  it("括号提示占第 1 行、正文第 2 行；无角色的块不显示括号提示", () => {
    expect(heightOf(grid, block({ characterIds: ["c1"], stageComment: "笑" }))).toBe(56);
    expect(heightOf(grid, block({ stageComment: "笑" }))).toBe(28);
  });
});

describe("estimateItemHeight：inline 前缀与场次标题", () => {
  it("inline 角色名吃掉正文首行等量宽度", () => {
    const inline: BlockStyle = {
      frame: { columns: [{ width: "1fr" }], gapX: 0 },
      padding: { top: 0, bottom: 0 },
      slots: [
        { id: "character", field: "character", box: { col: 1, row: 1 }, inline: true, style: NAME, decorate: { after: "：" }, hideIfEmpty: true },
        { id: "content", field: "content", box: { col: 1, row: 1 }, style: BODY, hideIfEmpty: false },
      ],
    };
    const upl = Math.floor(644 / 14); // 46
    // 正文 44 个字单独放得下一行；加上「林晚：」3 个全角单位就换行
    expect(heightOf(inline, block({ content: "中".repeat(44) }))).toBe(28);
    expect(heightOf(inline, block({ characterIds: ["c1"], content: "中".repeat(44) }))).toBe(56);
    expect(heightOf(inline, block({ characterIds: ["c1"], content: "中".repeat(upl - 3) }))).toBe(28);
  });

  it("场次标题即便拿不到场次表（槽全空）也按一行计", () => {
    const item = planSceneHeading("s1", null, { template: LEGACY_CENTER, characters: [], scenes: [], stageDelimOpen: "（", stageDelimClose: "）" });
    expect(estimateItemHeight(item, "normal", 644, EXACT)).toBe(12 + 20 + 12);
  });
});

describe("legacy 专用开关只在打开时起作用", () => {
  const grid: BlockStyle = {
    frame: { columns: [{ width: "7.5rem" }, { width: "1rem" }, { width: "1fr" }], gapX: 8 },
    padding: { top: 0, bottom: 0 },
    slots: [
      { id: "character", field: "character", box: { col: 1, row: 1, rowSpan: "all" }, style: { ...NAME, lineHeight: 28 }, hideIfEmpty: true },
      { id: "content", field: "content", box: { col: 3, row: 1 }, style: BODY, hideIfEmpty: false },
    ],
  };
  it("characterSlotHeight：角色名固定按 22px 另计（旧估算器口径）", () => {
    expect(heightOf(grid, block({ characterIds: ["c1"] }))).toBe(28);
    expect(heightOf(grid, block({ characterIds: ["c1"] }), 644, { countGapBefore: false, characterSlotHeight: 22 })).toBe(28 + 22);
  });
  it("estimateWidthInset：只影响估算的列宽", () => {
    const single: BlockStyle = {
      frame: { columns: [{ width: "1fr" }], gapX: 0 }, padding: { top: 0, bottom: 0 },
      slots: [{ id: "content", field: "content", box: { col: 1, row: 1 }, style: BODY, hideIfEmpty: false }],
    };
    const text = "中".repeat(40);
    expect(heightOf(single, block({ content: text }))).toBe(28);
    expect(heightOf({ ...single, estimateWidthInset: 152 }, block({ content: text }))).toBe(56);
  });
});
