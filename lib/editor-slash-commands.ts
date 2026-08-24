// `/` 指令源的候选表（语法大纲 §6.2 第四个注册项）。
//
// 定位：**指令不是方言**。人敲 `/fenlan` 只是「唤起分栏」这个动作的查询串，
// 选中的一刻即被丢弃，正文里不留痕迹（§6.1）。所以这张表里的东西一律不参与
// round-trip、不需要 canonical、**不进 AI 说明书**（§6.6：AI 恒写存储态，
// 让 AI 用指令语法 ≈ 让 AI 用右键菜单，是类别错误）。
//
// 三个已实现的指令源（`@` / `[[` / `#`）候选来自网络查询，这一个候选是静态表，
// 差异仅此而已——框架（makeSuggestion + DropPlugin）零改动。将来加 `/日期`、
// `/目录`、`/公式` 就是往这张表里加行。
import type { Editor } from "@tiptap/core";
import { match as pinyinMatch } from "pinyin-pro";
import { BLOCK_TYPES, type BlockTypeId } from "./editor-block-types";

export type SlashRange = { from: number; to: number };

/** 图标与名字来自 BLOCK_TYPES —— 与「转换为」菜单共用同一张表，
 *  免得同一个块类型在两个菜单里长两副样子 */
export type SlashCommand = {
  id: BlockTypeId;
  label: string;
  hint: string;
  icon: string;
  /** 英文/拼音别名。label 的拼音由 pinyin-pro 自动匹配，这里只补它推不出的 */
  keywords: string[];
  run: (editor: Editor, range: SlashRange) => void;
};

/** 拼装一条指令：展示位取自定式表，这里只补自己那份差异 */
function cmd(
  id: BlockTypeId,
  keywords: string[],
  run: (editor: Editor, range: SlashRange) => void,
): SlashCommand {
  return { id, ...BLOCK_TYPES[id], keywords, run };
}

export const SLASH_COMMANDS: SlashCommand[] = [
  cmd("h2", ["h2", "heading", "title"],
    (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 2 }).run()),
  cmd("h3", ["h3", "heading", "title"],
    (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 3 }).run()),
  cmd("bulletList", ["ul", "list", "bullet"],
    (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run()),
  cmd("orderedList", ["ol", "list", "number"],
    (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run()),
  cmd("taskList", ["todo", "task", "check"],
    (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run()),
  cmd("blockquote", ["quote", "blockquote"],
    (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run()),
  cmd("callout", ["callout", "tip", "note", "gaoliang"],
    (e, r) => e.chain().focus().deleteRange(r).toggleWrap("callout").run()),
  cmd("columns", ["cols", "column", "grid", "fenlan"],
    (e, r) => e.chain().focus().deleteRange(r).insertContent({
      type: "columnGroup",
      content: [
        { type: "column", content: [{ type: "paragraph" }] },
        { type: "column", content: [{ type: "paragraph" }] },
      ],
    }).run()),
  cmd("table", ["table", "biaoge"],
    (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
  cmd("codeBlock", ["code", "pre", "daima"],
    (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run()),
  cmd("horizontalRule", ["hr", "divider", "line", "fengexian"],
    (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run()),
];

/**
 * 按查询串过滤指令。空串给全表（`/` 敲完立刻看到能干什么，这是 slash 菜单的
 * 主要价值——不是搜索框，是**发现入口**）。
 *
 * 三路匹配：label 子串 / 别名前缀 / label 拼音（复用成员补全那套 pinyin-pro，
 * 「fenlan」「fl」都能命中「分栏」）。
 */
export function searchSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(c =>
    c.label.includes(q)
    || c.keywords.some(k => k.startsWith(q))
    || pinyinMatch(c.label, q) != null
  );
}
