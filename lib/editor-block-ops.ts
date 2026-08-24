// 块级操作（块结构编辑器 步骤 3）—— 整块复制/删除/移动/转类型 + 分栏增删栏。
//
// **全部走 ProseMirror transaction，不碰 serializer**（调研文档 §4.2）：这些操作
// 在文档树上进行，落盘时照样序列化成同一份干净 markdown。所以这一整个模块对
// 存储形态的影响是零，保真锁不需要为它做任何事。
//
// 抽成 lib 而不是写在组件里，是为了能对着真实 Editor 测「操作后序列化成什么」——
// 块操作最容易出的错不是点了没反应，而是**结构被改坏但要等下次保存才暴露**。
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

export type SelectedBlock = { node: PMNode; pos: number; end: number };

/** 当前的整块选中（没有则 null）。所有块操作的共同入口 */
export function getSelectedBlock(editor: Editor): SelectedBlock | null {
  const sel = editor.state.selection;
  if (!(sel instanceof NodeSelection)) return null;
  return { node: sel.node, pos: sel.from, end: sel.to };
}

/** 把整块选中收敛回块内文本光标位——转换类型这类命令吃的是文本选区 */
function insidePos(block: SelectedBlock): number {
  return block.pos + 1;
}

/**
 * 上/下移一格（dir=-1 上，dir=+1 下）。只在**同一个父节点内**换位——
 * 越级移动（把栏内的段落移出分栏）不是"移动"，是改结构，不该由方向键式的
 * 操作静默完成。
 */
export function moveBlock(editor: Editor, dir: -1 | 1): boolean {
  const block = getSelectedBlock(editor);
  if (!block) return false;
  const { state } = editor;
  const $pos = state.doc.resolve(block.pos);
  const depth = $pos.depth;
  const index = $pos.index(depth);
  const parent = $pos.parent;
  if (dir < 0 && index === 0) return false;
  if (dir > 0 && index >= parent.childCount - 1) return false;

  const size = block.end - block.pos;
  const tr = state.tr;
  let landing: number;
  if (dir < 0) {
    // 前一个兄弟的起点。删除发生在它之后，所以这个坐标不受删除影响
    landing = $pos.posAtIndex(index - 1, depth);
    tr.delete(block.pos, block.end);
    tr.insert(landing, block.node);
  } else {
    // 后一个兄弟的终点，减去被删掉的自身长度
    landing = $pos.posAtIndex(index + 2, depth) - size;
    tr.delete(block.pos, block.end);
    tr.insert(landing, block.node);
  }
  // 移完保持选中——连按两下上移是最自然的用法，每次都要重新点手柄就废了
  tr.setSelection(NodeSelection.create(tr.doc, landing));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** 原地复制一份，落在原块正下方并选中新的那份 */
export function duplicateBlock(editor: Editor): boolean {
  const block = getSelectedBlock(editor);
  if (!block) return false;
  const tr = editor.state.tr;
  tr.insert(block.end, block.node);
  tr.setSelection(NodeSelection.create(tr.doc, block.end));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** 删除整块 */
export function deleteBlock(editor: Editor): boolean {
  const block = getSelectedBlock(editor);
  if (!block) return false;
  editor.view.dispatch(editor.state.tr.delete(block.pos, block.end));
  editor.commands.focus();
  return true;
}

// ── 转换类型 ─────────────────────────────────────────────────────────────────

export type TurnIntoOption = {
  id: string;
  label: string;
  run: (editor: Editor, inside: number) => void;
};

export const TURN_INTO: TurnIntoOption[] = [
  { id: "paragraph", label: "正文", run: (e, p) => e.chain().focus().setTextSelection(p).setParagraph().run() },
  { id: "h2", label: "二级标题", run: (e, p) => e.chain().focus().setTextSelection(p).setHeading({ level: 2 }).run() },
  { id: "h3", label: "三级标题", run: (e, p) => e.chain().focus().setTextSelection(p).setHeading({ level: 3 }).run() },
  { id: "bulletList", label: "无序列表", run: (e, p) => e.chain().focus().setTextSelection(p).toggleBulletList().run() },
  { id: "orderedList", label: "有序列表", run: (e, p) => e.chain().focus().setTextSelection(p).toggleOrderedList().run() },
  { id: "taskList", label: "任务列表", run: (e, p) => e.chain().focus().setTextSelection(p).toggleTaskList().run() },
  { id: "blockquote", label: "引用", run: (e, p) => e.chain().focus().setTextSelection(p).toggleBlockquote().run() },
  { id: "callout", label: "高亮块", run: (e, p) => e.chain().focus().setTextSelection(p).toggleWrap("callout").run() },
  { id: "codeBlock", label: "代码块", run: (e, p) => e.chain().focus().setTextSelection(p).toggleCodeBlock().run() },
];

/**
 * 结构型节点不给「转换类型」——把一个 columnGroup 变成标题没有意义，
 * 而这些命令在结构节点上的行为是未定义的（多半静默失败或把内容拍平）。
 */
const UNCONVERTIBLE = new Set(["columnGroup", "column", "table", "image", "horizontalRule"]);

export function canTurnInto(node: PMNode | null): boolean {
  return !!node && !UNCONVERTIBLE.has(node.type.name);
}

export function turnInto(editor: Editor, optionId: string): boolean {
  const block = getSelectedBlock(editor);
  if (!block || !canTurnInto(block.node)) return false;
  const opt = TURN_INTO.find(o => o.id === optionId);
  if (!opt) return false;
  opt.run(editor, insidePos(block));
  return true;
}

// ── 分栏操作 ─────────────────────────────────────────────────────────────────

/** 选中的是否是分栏组 */
export function isColumnGroup(node: PMNode | null): boolean {
  return node?.type.name === "columnGroup";
}

/**
 * 增/减一栏。栏数变化后**一律清空所有 ratio**——旧的宽度串是按旧栏数配的，
 * 留着就会让 columnGroup 的 serializer 走进「ratios.length !== childCount」
 * 分支、主参数位整个不写，用户看到的是"我明明设过宽度怎么没了"。清空＝
 * 显式回到均分，与不写主参数位的 canonical 形态一致。
 */
export function changeColumnCount(editor: Editor, delta: 1 | -1): boolean {
  const block = getSelectedBlock(editor);
  if (!block || !isColumnGroup(block.node)) return false;
  const group = block.node;
  const count = group.childCount;
  const next = count + delta;
  // content 是 `column column+`：少于两栏组就不成立
  if (next < 2) return false;

  const { schema } = editor.state;
  const columns: PMNode[] = [];
  for (let i = 0; i < Math.min(count, next); i++) {
    columns.push(schema.nodes.column.create(null, group.child(i).content));
  }
  if (delta > 0) {
    columns.push(schema.nodes.column.create(null, schema.nodes.paragraph.create()));
  }
  const tr = editor.state.tr;
  tr.replaceWith(block.pos, block.end, schema.nodes.columnGroup.create(group.attrs, columns));
  tr.setSelection(NodeSelection.create(tr.doc, block.pos));
  editor.view.dispatch(tr);
  return true;
}

/** 均分各栏（清空 ratio，回到 canonical 的"不写主参数位"形态） */
export function equalizeColumns(editor: Editor): boolean {
  const block = getSelectedBlock(editor);
  if (!block || !isColumnGroup(block.node)) return false;
  const group = block.node;
  if (group.content.content.every((c: PMNode) => c.attrs.ratio == null)) return false; // 本来就均分
  const { schema } = editor.state;
  const columns: PMNode[] = [];
  for (let i = 0; i < group.childCount; i++) {
    columns.push(schema.nodes.column.create(null, group.child(i).content));
  }
  const tr = editor.state.tr;
  tr.replaceWith(block.pos, block.end, schema.nodes.columnGroup.create(group.attrs, columns));
  tr.setSelection(NodeSelection.create(tr.doc, block.pos));
  editor.view.dispatch(tr);
  return true;
}
