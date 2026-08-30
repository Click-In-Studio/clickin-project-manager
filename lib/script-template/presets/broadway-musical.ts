/**
 * 百老汇音乐剧示范模版——按 Samuel French / Dramatists Guild 的 Formatting Guide 逐条落：
 *
 *   · 角色名居中、全大写（拉丁文；中文名不受影响）；跨页续说补 `(Cont.)`
 *   · 简短提示跟在角色名同一行 `JOHN (laughing)`；长提示另起一行、缩进三个 indent、括号内
 *   · 台词左对齐、通栏、单倍行距；两段 speech 之间空一行
 *   · 歌词全大写、缩进一个 indent、左对齐
 *   · 舞台指示括号内、左缩进三个 indent、右边也停在三个 indent
 *   · 每幕 / 每场另起一页、居中：`ACT I`（大写罗马）/ `Scene 1`（下划线）
 *   · 页码 `I – 1 – 51`（幕–场–页）右上，全剧连续；无页脚；无目录页
 *
 * 一个 indent 按 0.5 英寸 = 48px（规范写「12 空格 TNR / 5 空格 Courier」，约半英寸）。
 * 字号 12pt = 16px；行高 26px（单倍行距在中文里太挤，取 1.6）。
 *
 * 规范里有、这里没有的（内容模型没有对应数据）：歌前的 `(Song: "TITLE")` 行、Setting / At Rise、
 * 人物表与音乐编号页、CURTAIN / END OF ACT——它们分别归 K（外部引用）与 F（页序列）。
 */
import type { BlockStyle, Rule, ScriptTemplate, TextStyle } from "../types";

const INDENT = 48;
const FONT = 16;
const LINE = 26;

const BODY: TextStyle = { face: "script", fontSize: FONT, lineHeight: LINE, color: "#18181b", align: "left" };
const NAME: TextStyle = { face: "script", fontSize: FONT, lineHeight: LINE, case: "upper", color: "#18181b", align: "center" };
const PAREN: TextStyle = { face: "stage", fontSize: FONT, lineHeight: LINE, color: "#3f3f46" };
const LYRIC: TextStyle = { face: "lyric", fontSize: FONT, lineHeight: LINE, case: "upper", color: "#18181b", align: "left" };
const STAGE: TextStyle = { face: "stage", fontSize: FONT, lineHeight: LINE, color: "#3f3f46", align: "left" };
const HEADING_ACT: TextStyle = { face: "script", fontSize: FONT, lineHeight: LINE, case: "upper", color: "#18181b", align: "center" };
const HEADING_SCENE: TextStyle = { face: "script", fontSize: FONT, lineHeight: LINE, underline: true, color: "#18181b", align: "center" };

const SINGLE = { columns: [{ width: "1fr" }], gapX: 0 };

/** 简短提示的上限：规范只说「brief」；一行以内当简短 */
const BRIEF_COMMENT_MAX_CHARS = 24;

const DIALOGUE: BlockStyle = {
  frame: SINGLE,
  padding: { top: 0, bottom: 0 },
  slots: [
    // 第 1 行：角色名 + 简短提示连成一行居中（两个 inline 槽，同行无占格槽 → 文字流）
    { id: "character", field: "character", box: { col: 1, row: 1 }, inline: true, style: NAME, hideIfEmpty: true },
    { id: "briefComment", field: "stageComment", box: { col: 1, row: 1 }, inline: true, style: PAREN, hideIfEmpty: true, requireCharacters: true, when: { maxChars: BRIEF_COMMENT_MAX_CHARS } },
    // 长提示：另起一行、三个 indent、括号内（stageComment 的括号取演出配置的分隔符）
    { id: "longComment", field: "stageComment", box: { col: 1, row: 2 }, style: { ...PAREN, align: "left" }, indent: { left: INDENT * 3 }, hideIfEmpty: true, requireCharacters: true, when: { minChars: BRIEF_COMMENT_MAX_CHARS + 1 } },
    { id: "content", field: "content", box: { col: 1, row: 3 }, style: BODY, hideIfEmpty: false },
  ],
};

const LYRIC_STYLE: BlockStyle = {
  frame: SINGLE,
  padding: { top: 0, bottom: 0 },
  slots: [
    { id: "character", field: "character", box: { col: 1, row: 1 }, inline: true, style: NAME, hideIfEmpty: true },
    { id: "briefComment", field: "stageComment", box: { col: 1, row: 1 }, inline: true, style: PAREN, hideIfEmpty: true, requireCharacters: true, when: { maxChars: BRIEF_COMMENT_MAX_CHARS } },
    { id: "longComment", field: "stageComment", box: { col: 1, row: 2 }, style: { ...PAREN, align: "left" }, indent: { left: INDENT * 3 }, hideIfEmpty: true, requireCharacters: true, when: { minChars: BRIEF_COMMENT_MAX_CHARS + 1 } },
    // 歌词：全大写、一个 indent
    { id: "content", field: "content", box: { col: 1, row: 3 }, style: LYRIC, indent: { left: INDENT }, hideIfEmpty: false },
  ],
};

const STAGE_STYLE: BlockStyle = {
  frame: SINGLE,
  padding: { top: 0, bottom: 0 },
  slots: [
    // 括号内、左右各三个 indent
    { id: "content", field: "content", box: { col: 1, row: 1 }, style: STAGE, decorate: { before: "(", after: ")" }, indent: { left: INDENT * 3, right: INDENT * 3 }, hideIfEmpty: false },
  ],
};

const SCENE_HEADING: BlockStyle = {
  frame: SINGLE,
  padding: { top: 0, bottom: LINE },
  slots: [
    { id: "act", field: "act.roman", box: { col: 1, row: 1 }, style: HEADING_ACT, decorate: { before: "ACT " }, hideIfEmpty: true },
    { id: "scene", field: "scene.local", box: { col: 1, row: 2 }, style: HEADING_SCENE, decorate: { before: "Scene " }, hideIfEmpty: true },
  ],
};

const RULES: Rule[] = [
  {
    // 连续同角色（同场同记号、未强制显名）→ 省略角色名（同一段 speech 的延续）
    id: "hide-repeated-character",
    styles: ["dialogue", "lyric"],
    when: { type: "dialogue", prevType: "dialogue", prevSameScene: true, prevSameRehearsalMark: true, prevSameCharacters: true, forceShowCharacterName: false },
    then: { hide: ["character", "briefComment", "longComment"] },
  },
  {
    // speech 之间空一行：舞台指示前、说话人切换前、无角色对白前
    id: "blank-line-between-speeches",
    when: { hasPrev: true, slotVisible: "character" },
    then: { gapBefore: LINE },
  },
  {
    id: "blank-line-before-stage",
    styles: ["stage"],
    when: { hasPrev: true },
    then: { gapBefore: LINE },
  },
  {
    id: "blank-line-before-anonymous",
    styles: ["dialogue", "lyric"],
    when: { hasPrev: true, hasCharacters: false },
    then: { gapBefore: LINE },
  },
  {
    // 跨页续说：本页首块若角色名被省略，补回来并加 (Cont.)
    id: "continued-on-page-top",
    styles: ["dialogue", "lyric"],
    when: { firstOnPage: true, slotHidden: "character", hasCharacters: true },
    then: { show: ["character"], suffix: { character: " (Cont.)" } },
  },
  {
    // 每幕 / 每场另起一页
    id: "new-page-per-scene",
    styles: ["sceneHeading"],
    when: { isSceneStart: true },
    then: { breakBefore: "page" },
  },
];

export const BROADWAY_MUSICAL: ScriptTemplate = {
  id: "broadway-musical@1",
  name: "百老汇音乐剧",
  version: 1,
  page: {
    // 页码 幕–场–页 右上；无页脚；无目录
    header: { items: [{ field: "act.roman" }, { text: " – " }, { field: "scene.local" }, { text: " – " }, { field: "page.number" }], align: "right", style: { face: "script", fontSize: FONT, lineHeight: 28, color: "#18181b" } },
    footer: { items: [], align: "center", style: { face: "script", fontSize: 12, lineHeight: 28, color: "#71717a" } },
    toc: { enabled: false },
  },
  blockStyles: { dialogue: DIALOGUE, lyric: LYRIC_STYLE, stage: STAGE_STYLE, sceneHeading: SCENE_HEADING },
  rules: RULES,
  estimate: { countGapBefore: true },
};
