// `/` 指令源的候选表（语法大纲 §6.2 第四个注册项）。
//
// 定位：**指令不是方言**。人敲 `/fenlan` 只是「唤起分栏」这个动作的查询串，
// 选中的一刻即被丢弃，正文里不留痕迹（§6.1）。所以这张表里的东西一律不参与
// round-trip、不需要 canonical、**不进 AI 说明书**（§6.6：AI 恒写存储态，
// 让 AI 用指令语法 ≈ 让 AI 用右键菜单，是类别错误）。
//
// `@` / `[[` / `#` 的候选来自网络查询，slash 第一层来自静态表。布局项选中后
// 直接改编辑器；「引用… / 嵌入素材」选中后打开二级搜索面板——动作类型显式写在
// 每一行上，不再假设所有 slash 项都必须同步落一个块。
import type { Editor } from "@tiptap/core";
import { match as pinyinMatch } from "pinyin-pro";
import { BLOCK_TYPES, type BlockTypeId } from "./editor-block-types";

export type SlashRange = { from: number; to: number };

/** 图标与名字来自 BLOCK_TYPES —— 与「转换为」菜单共用同一张表，
 *  免得同一个块类型在两个菜单里长两副样子 */
type SlashCommandBase = {
  id: string;
  label: string;
  hint: string;
  icon: string;
  /** 英文/拼音别名。label 的拼音由 pinyin-pro 自动匹配，这里只补它推不出的 */
  keywords: string[];
};

export type SlashPickerMode = "reference" | "embed";

export type SlashCommand = SlashCommandBase & ({
  kind: "editor";
  id: BlockTypeId;
  run: (editor: Editor, range: SlashRange) => void;
} | {
  kind: "picker";
  id: "referencePicker" | "embedAssetPicker";
  picker: SlashPickerMode;
});

/** 拼装一条指令：展示位取自定式表，这里只补自己那份差异 */
function cmd(
  id: BlockTypeId,
  keywords: string[],
  run: (editor: Editor, range: SlashRange) => void,
): SlashCommand {
  return { kind: "editor", id, ...BLOCK_TYPES[id], keywords, run };
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // 顺序就是菜单的信息架构：文字层级 → 列表 → 内容块 → 布局 → 外部内容。
  cmd("h1", ["h1", "heading", "title"],
    (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 1 }).run()),
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
  cmd("codeBlock", ["code", "pre", "daima"],
    (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run()),
  cmd("horizontalRule", ["hr", "divider", "line", "fengexian"],
    (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run()),
  cmd("table", ["table", "biaoge"],
    (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
  cmd("columns", ["cols", "column", "grid", "fenlan"],
    (e, r) => e.chain().focus().deleteRange(r).insertContent({
      type: "columnGroup",
      content: [
        { type: "column", content: [{ type: "paragraph" }] },
        { type: "column", content: [{ type: "paragraph" }] },
      ],
    }).run()),
  {
    kind: "picker", id: "referencePicker", picker: "reference",
    label: "引用…", icon: "#", hint: "文档、素材、场次、Cue",
    keywords: ["reference", "link", "yinyong"],
  },
  {
    kind: "picker", id: "embedAssetPicker", picker: "embed",
    label: "嵌入素材", icon: "▣", hint: "图片、视频、音频",
    keywords: ["embed", "asset", "media", "qianru", "sucai"],
  },
];

/**
 * 按查询串过滤指令。空串给全表（`/` 敲完立刻看到能干什么，这是 slash 菜单的
 * 主要价值——不是搜索框，是**发现入口**）。
 *
 * 三路匹配：label 子串 / 别名前缀 / label 拼音（复用成员补全那套 pinyin-pro，
 * 「fenlan」「fl」都能命中「分栏」）。
 */
export function searchSlashCommands(
  query: string,
  options: { includePickers?: boolean } = {},
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const commands = options.includePickers === false
    ? SLASH_COMMANDS.filter(command => command.kind === "editor")
    : SLASH_COMMANDS;
  if (!q) return commands;
  return commands.filter(c =>
    c.label.includes(q)
    || c.keywords.some(k => k.startsWith(q))
    || pinyinMatch(c.label, q) != null
  );
}
