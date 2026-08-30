/**
 * legacy 模版：用模版数据**逐字复现**今天 `textLayoutMode` 的两种输出
 * （docs/script-template-engine.md §4）。它是引擎的第一块试金石：
 *   · 估算：computePageMap / updateEstimatedPageMap 与旧实现逐字节相同（测试里带旧实现当参照）
 *   · 打印：B3 的 golden 不变
 *
 * 数值全部来自旧代码的 Tailwind 类：text-sm = 14px / 20px 行高，leading-7 = 28px，
 * py-1 = 4+4，mb-0.5 = 2，h-2.5 = 10，compact 左栏 7.5rem + 1rem + gap-x-2（0.5rem×2）。
 */
import type { BlockStyle, Rule, ScriptTemplate, TextStyle } from "../types";

const BODY: TextStyle = { face: "script", fontSize: 14, lineHeight: 28, color: "#27272a" };
const CHARACTER: TextStyle = { face: "script", fontSize: 14, lineHeight: 20, weight: "bold", letterSpacing: "0.12em", color: "#27272a", align: "center" };
const CHARACTER_COMPACT: TextStyle = { ...CHARACTER, lineHeight: 28, align: "right" };
const STAGE_COMMENT: TextStyle = { face: "stage", fontSize: 14, lineHeight: 28, italic: true, color: "#a1a1aa", whiteSpace: "pre-wrap" };
const SCENE_NUMBER: TextStyle = { face: "script", fontSize: 12, lineHeight: 16, weight: "bold", letterSpacing: "0.1em", color: "#a1a1aa" };
const SCENE_NAME: TextStyle = { face: "script", fontSize: 14, lineHeight: 20, color: "#71717a" };

const SINGLE_COLUMN = { columns: [{ width: "1fr" }], gapX: 0 };

/** 规则：今天 shouldHideCharacterLabel / shouldShowCharacterGap / 页首补名 的逐条翻译。按序求值。 */
const LEGACY_RULES: Rule[] = [
  {
    // shouldHideCharacterLabel：连续同角色 + 同场 + 同排练记号，且未强制显示 → 省略角色名；
    // 外沿也随之归零（py-0）——注意它不看有没有角色，无角色的连续对白块同样归零
    id: "hide-repeated-character",
    styles: ["dialogue", "lyric"],
    when: { type: "dialogue", prevType: "dialogue", prevSameScene: true, prevSameRehearsalMark: true, prevSameCharacters: true, forceShowCharacterName: false },
    then: { hide: ["character"], paddingTop: 0, paddingBottom: 0 },
  },
  {
    // shouldShowCharacterGap 之一：舞台指示块前，若前一块不是舞台指示 → 10px
    id: "gap-before-stage",
    styles: ["stage"],
    when: { hasPrev: true, not: { prevType: "stage" } },
    then: { gapBefore: 10 },
  },
  {
    // 之二：无角色的对白块，除非前一块也是同场同记号的无角色对白 → 10px
    id: "gap-before-anonymous-dialogue",
    styles: ["dialogue", "lyric"],
    when: { hasPrev: true, hasCharacters: false, not: { all: [{ prevType: "dialogue" }, { prevHasCharacters: false }, { prevSameScene: true }, { prevSameRehearsalMark: true }] } },
    then: { gapBefore: 10 },
  },
  {
    // 之三：有角色且角色名未被省略 → 10px（说话人切换）
    id: "gap-before-speaker",
    styles: ["dialogue", "lyric"],
    when: { hasPrev: true, hasCharacters: true, slotVisible: "character" },
    then: { gapBefore: 10 },
  },
  {
    // 本页首块把省略的角色名补回来，外沿恢复（forcedHeight）
    id: "show-character-on-page-top",
    styles: ["dialogue", "lyric"],
    when: { firstOnPage: true },
    then: { show: ["character"], paddingTop: 4, paddingBottom: 4 },
  },
];

function legacyCenterDialogue(body: TextStyle): BlockStyle {
  return {
    frame: SINGLE_COLUMN,
    padding: { top: 4, bottom: 4 },
    slots: [
      { id: "character", field: "character", box: { col: 1, row: 1 }, style: CHARACTER, marginBottom: 2, hideIfEmpty: true },
      // legacy-center 把括号提示与正文放同一个 div（一起走 mdToHtml，括号因此拿到行内舞台指示样式）
      { id: "content", field: ["stageComment", "content"], joiner: "\n", box: { col: 1, row: 2 }, style: { ...body, align: "center" }, hideIfEmpty: false, requireCharacters: true },
    ],
  };
}

function legacyCompactDialogue(body: TextStyle): BlockStyle {
  return {
    frame: { columns: [{ width: "7.5rem" }, { width: "1rem" }, { width: "1fr" }], gapX: 8 },
    padding: { top: 4, bottom: 4 },
    slots: [
      { id: "character", field: "character", box: { col: 1, row: 1, rowSpan: "all" }, style: CHARACTER_COMPACT, hideIfEmpty: true, opticalOffsetY: 1 },
      { id: "stageComment", field: "stageComment", box: { col: 3, row: 1 }, style: STAGE_COMMENT, hideIfEmpty: true, requireCharacters: true },
      { id: "content", field: "content", box: { col: 3, row: 2 }, style: { ...body, align: "left" }, hideIfEmpty: false, alignFirstLineTo: "character" },
    ],
  };
}

const LEGACY_STAGE: BlockStyle = {
  frame: SINGLE_COLUMN,
  padding: { top: 0, bottom: 0 },
  slots: [
    { id: "content", field: "content", box: { col: 1, row: 1 }, style: { face: "stage", fontSize: 14, lineHeight: 28, italic: true, color: "#71717a", align: "left" }, hideIfEmpty: false },
  ],
};
/** compact 下舞台指示仍通栏渲染，但旧估算器按「减去左栏」的宽度估它的行数——估算口径的 quirk */
const LEGACY_STAGE_COMPACT: BlockStyle = { ...LEGACY_STAGE, estimateWidthInset: 7.5 * 16 + 16 + 16 };

const LEGACY_SCENE_HEADING: BlockStyle = {
  // flex items-center gap-3 py-3：一行，两侧横线（decoration）夹着场号与场名；估算按一行 20 + 24
  frame: { columns: [{ width: "auto" }, { width: "1fr" }], gapX: 8 },
  padding: { top: 12, bottom: 12 },
  decoration: "rule-lines",
  slots: [
    { id: "scene.number", field: "scene.number", box: { col: 1, row: 1 }, style: SCENE_NUMBER, hideIfEmpty: true },
    { id: "scene.name", field: "scene.name", box: { col: 2, row: 1 }, style: SCENE_NAME, hideIfEmpty: true },
  ],
};

const LYRIC_BODY: TextStyle = { face: "lyric", fontSize: 14, lineHeight: 28, weight: "bold", case: "upper", color: "#27272a" };

function legacyTemplate(id: string, name: string, compact: boolean): ScriptTemplate {
  const dialogue = compact ? legacyCompactDialogue(BODY) : legacyCenterDialogue(BODY);
  const lyric = compact ? legacyCompactDialogue(LYRIC_BODY) : legacyCenterDialogue(LYRIC_BODY);
  return {
    id,
    name,
    version: 1,
    page: {
      // 页眉：场次标签（text-[10px] font-medium tracking-widest uppercase zinc-400），首页靠右、逐页交替
      header: { items: [{ field: "scene.label" }], align: "alternate", firstPage: "right", style: { face: "script", fontSize: 10, lineHeight: 28, weight: "medium", letterSpacing: "0.1em", color: "#a1a1aa", case: "upper" } },
      // 页脚：— N —（text-xs zinc-500）居中
      footer: { items: [{ text: "— " }, { field: "page.number" }, { text: " —" }], align: "center", style: { face: "script", fontSize: 12, lineHeight: 28, color: "#71717a" } },
      toc: { enabled: true },
    },
    blockStyles: { dialogue, lyric, stage: compact ? LEGACY_STAGE_COMPACT : LEGACY_STAGE, sceneHeading: LEGACY_SCENE_HEADING },
    rules: LEGACY_RULES,
    estimate: { countGapBefore: false, characterSlotHeight: 22 },
  };
}

// 预设 id 带版本：改预设 = 发新版本，演出主动升级——页码是剧组坐标，不能被一次样式改动悄悄挪走
export const LEGACY_CENTER: ScriptTemplate = legacyTemplate("legacy-center@1", "居中角色名", false);
export const LEGACY_COMPACT: ScriptTemplate = legacyTemplate("legacy-compact@1", "左栏角色名", true);
