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

export type SlashRange = { from: number; to: number };

export type SlashCommand = {
  id: string;
  /** 菜单里显示的名字 */
  label: string;
  /** 右侧灰字提示，说明落成什么 */
  hint: string;
  /** 单字符图标，与固定工具栏原有符号保持一致（老用户认得） */
  icon: string;
  /** 英文/拼音别名。label 的拼音由 pinyin-pro 自动匹配，这里只补它推不出的 */
  keywords: string[];
  run: (editor: Editor, range: SlashRange) => void;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "h2", label: "二级标题", hint: "## 标题", icon: "H2", keywords: ["h2", "heading", "title"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 2 }).run(),
  },
  {
    id: "h3", label: "三级标题", hint: "### 标题", icon: "H3", keywords: ["h3", "heading", "title"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 3 }).run(),
  },
  {
    id: "bulletList", label: "无序列表", hint: "- 条目", icon: "≡", keywords: ["ul", "list", "bullet"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: "orderedList", label: "有序列表", hint: "1. 条目", icon: "1.", keywords: ["ol", "list", "number"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: "taskList", label: "任务列表", hint: "- [ ] 待办", icon: "☑", keywords: ["todo", "task", "check"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: "blockquote", label: "引用", hint: "> 引用", icon: "“", keywords: ["quote", "blockquote"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    id: "callout", label: "高亮块", hint: "> [!💡]", icon: "💡", keywords: ["callout", "tip", "note", "gaoliang"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleWrap("callout").run(),
  },
  {
    id: "columns", label: "两栏分栏", hint: ":::cols", icon: "◫", keywords: ["cols", "column", "grid", "fenlan"],
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent({
      type: "columnGroup",
      content: [
        { type: "column", content: [{ type: "paragraph" }] },
        { type: "column", content: [{ type: "paragraph" }] },
      ],
    }).run(),
  },
  {
    id: "table", label: "表格", hint: "3×3 带表头", icon: "⊞", keywords: ["table", "biaoge"],
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "codeBlock", label: "代码块", hint: "```", icon: "{ }", keywords: ["code", "pre", "daima"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: "horizontalRule", label: "分割线", hint: "---", icon: "—", keywords: ["hr", "divider", "line", "fengexian"],
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
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
