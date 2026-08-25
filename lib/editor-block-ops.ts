// 块级操作（块结构编辑器 步骤 3）—— 整块复制/删除/移动/转类型 + 分栏增删栏。
//
// **全部走 ProseMirror transaction，不碰 serializer**（调研文档 §4.2）：这些操作
// 在文档树上进行，落盘时照样序列化成同一份干净 markdown。所以这一整个模块对
// 存储形态的影响是零，保真锁不需要为它做任何事。
//
// 抽成 lib 而不是写在组件里，是为了能对着真实 Editor 测「操作后序列化成什么」——
// 块操作最容易出的错不是点了没反应，而是**结构被改坏但要等下次保存才暴露**。
import { NodeSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { removeColumnsAt, insertColumnAt } from "./tiptap-column-editing";
import { BLOCK_TYPES, type BlockTypeId } from "./editor-block-types";

export type SelectedBlock = { node: PMNode; pos: number; end: number };

/** 当前的整块选中（没有则 null）。所有块操作的共同入口 */
export function getSelectedBlock(editor: Editor): SelectedBlock | null {
  const sel = editor.state.selection;
  if (!(sel instanceof NodeSelection)) return null;
  return { node: sel.node, pos: sel.from, end: sel.to };
}

/**
 * 把 pos 处的节点设为整块选中。**选不中就算了，不抛。**
 *
 * NodeSelection.create 在目标不可选中时会抛；而调用它的地方都是"内容已经改好
 * 了，顺手把选中放回去"——为了一个选区把整次操作抛进点击处理里，是拿一次崩溃
 * 换一次选中，不划算。别处（selectColumnGroup / changeColumnCount）本来就是
 * 这么兜的，这里补齐一致性。
 */
function selectNodeAt(tr: Transaction, pos: number): void {
  try {
    tr.setSelection(NodeSelection.create(tr.doc, pos));
  } catch { /* 目标不可选中：内容已经搬好，选不中不影响正确性 */ }
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

  // 落点先按**删除前**的坐标取，再用 tr.mapping 映射到删除后。
  // 原先是分方向手算（下移时减去自身长度），算得没错，但那种位置记账正是
  // 一改结构就会悄悄失效的写法——本模块存在的理由就是"结构被改坏要等下次
  // 保存才暴露"，不该在自己身上留这种账。映射之后两个方向合成一条路径。
  const target = dir < 0
    ? $pos.posAtIndex(index - 1, depth)   // 前一个兄弟的起点
    : $pos.posAtIndex(index + 2, depth);  // 后一个兄弟的终点
  const tr = state.tr;
  tr.delete(block.pos, block.end);
  const landing = tr.mapping.map(target);
  tr.insert(landing, block.node);
  // 移完保持选中——连按两下上移是最自然的用法，每次都要重新点手柄就废了。
  // 选不中不算失败：内容已经搬好了，为了个选区把整次操作抛出去更糟
  selectNodeAt(tr, landing);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** 原地复制一份，落在原块正下方并选中新的那份 */
export function duplicateBlock(editor: Editor): boolean {
  const block = getSelectedBlock(editor);
  if (!block) return false;
  const tr = editor.state.tr;
  tr.insert(block.end, block.node);
  selectNodeAt(tr, block.end);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** 删除整块。选中的是一整栏时走摘栏路径——直接 delete 会把组留成一栏，
 *  而 `column column+` 不允许（剩一栏要拆组，内容原地保留） */
export function deleteBlock(editor: Editor): boolean {
  const block = getSelectedBlock(editor);
  if (!block) return false;
  const tr = editor.state.tr;
  if (block.node.type.name === "column") {
    if (!removeColumnsAt(tr, [block.pos])) return false;
  } else {
    tr.delete(block.pos, block.end);
  }
  editor.view.dispatch(tr);
  editor.commands.focus();
  return true;
}

// ── 转换类型 ─────────────────────────────────────────────────────────────────

/** 图标与名字来自 BLOCK_TYPES —— 与 `/` 插入菜单共用同一张表。同一个块类型
 *  在「新建」和「转换为」里必须长同一副样子，否则用户会以为是两个东西 */
export type TurnIntoOption = {
  id: BlockTypeId;
  label: string;
  icon: string;
  hint: string;
  /** 返回底层命令的成败 —— 见 turnInto 的注释，不许吞 */
  run: (editor: Editor, inside: number) => boolean;
};

function option(id: BlockTypeId, run: TurnIntoOption["run"]): TurnIntoOption {
  return { id, ...BLOCK_TYPES[id], run };
}

export const TURN_INTO: TurnIntoOption[] = [
  option("paragraph", (e, p) => e.chain().focus().setTextSelection(p).setParagraph().run()),
  option("h2", (e, p) => e.chain().focus().setTextSelection(p).setHeading({ level: 2 }).run()),
  option("h3", (e, p) => e.chain().focus().setTextSelection(p).setHeading({ level: 3 }).run()),
  option("bulletList", (e, p) => e.chain().focus().setTextSelection(p).toggleBulletList().run()),
  option("orderedList", (e, p) => e.chain().focus().setTextSelection(p).toggleOrderedList().run()),
  option("taskList", (e, p) => e.chain().focus().setTextSelection(p).toggleTaskList().run()),
  option("blockquote", (e, p) => e.chain().focus().setTextSelection(p).toggleBlockquote().run()),
  option("callout", (e, p) => e.chain().focus().setTextSelection(p).toggleWrap("callout").run()),
  option("codeBlock", (e, p) => e.chain().focus().setTextSelection(p).toggleCodeBlock().run()),
];

/**
 * 结构型节点不给「转换类型」——把一个 columnGroup 变成标题没有意义，
 * 而这些命令在结构节点上的行为是未定义的（多半静默失败或把内容拍平）。
 */
const UNCONVERTIBLE = new Set(["columnGroup", "column", "table", "image", "horizontalRule"]);

export function canTurnInto(node: PMNode | null): boolean {
  return !!node && !UNCONVERTIBLE.has(node.type.name);
}

/**
 * 转换当前选中块的类型。返回的是**底层命令的真实成败**，不是"我调过了"。
 *
 * 原先无条件返回 true，把 chain().run() 的结果丢掉了：toggleWrap 拒绝、
 * setTextSelection 之后选区失效之类的静默失败，调用侧一律看成成功。
 */
export function turnInto(editor: Editor, optionId: string): boolean {
  const block = getSelectedBlock(editor);
  if (!block || !canTurnInto(block.node)) return false;
  const opt = TURN_INTO.find(o => o.id === optionId);
  if (!opt) return false;
  return opt.run(editor, insidePos(block));
}

// ── 分栏操作 ─────────────────────────────────────────────────────────────────

/** 选中的是否是分栏组 */
export function isColumnGroup(node: PMNode | null): boolean {
  return node?.type.name === "columnGroup";
}

/**
 * 找到「当前光标/选中所处的分栏组」——选中的就是组时给它自己，否则沿祖先上溯。
 *
 * 需要上溯是因为手柄**刻意不再把分栏组作为目标**（见 BlockHandle 的
 * UNDRAGGABLE：命中评分在内层块与整组之间摇摆是实测到的不确定行为）。
 * 于是分栏操作必须能从「栏内的某一块」够到它所属的组，否则组一旦选不中，
 * ＋栏/－栏/均分 就全都够不着了。
 */
export function findColumnGroup(editor: Editor): SelectedBlock | null {
  const selected = getSelectedBlock(editor);
  if (selected && isColumnGroup(selected.node)) return selected;
  const $from = editor.state.selection.$from;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (node.type.name === "columnGroup") {
      const pos = $from.before(d);
      return { node, pos, end: pos + node.nodeSize };
    }
  }
  return null;
}

/** 选中祖先分栏组 —— 之后上移/下移/复制/删除就作用于整组 */
export function selectColumnGroup(editor: Editor): boolean {
  const group = findColumnGroup(editor);
  if (!group) return false;
  const tr = editor.state.tr;
  try {
    tr.setSelection(NodeSelection.create(tr.doc, group.pos));
  } catch {
    return false;
  }
  editor.view.dispatch(tr);
  editor.commands.focus();
  return true;
}

/**
 * 增/减一栏。栏数变化后**一律清空所有 ratio**——旧的宽度串是按旧栏数配的，
 * 留着就会让 columnGroup 的 serializer 走进「ratios.length !== childCount」
 * 分支、主参数位整个不写，用户看到的是"我明明设过宽度怎么没了"。清空＝
 * 显式回到均分，与不写主参数位的 canonical 形态一致。
 */
export function changeColumnCount(editor: Editor, delta: 1 | -1): boolean {
  const block = findColumnGroup(editor);
  if (!block) return false;
  const group = block.node;
  const count = group.childCount;
  // content 是 `column column+`：少于两栏组就不成立
  if (count + delta < 2) return false;

  const tr = editor.state.tr;
  if (delta > 0) {
    if (!insertColumnAt(tr, block.pos, count)) return false; // 追加到末尾
  } else {
    // 末尾那一栏的位置
    let last = block.pos + 1;
    for (let i = 0; i < count - 1; i++) last += group.child(i).nodeSize;
    if (!removeColumnsAt(tr, [last])) return false;
  }
  try {
    tr.setSelection(NodeSelection.create(tr.doc, block.pos));
  } catch { /* 组已被拆掉（减到一栏）——不强求选中 */ }
  editor.view.dispatch(tr);
  return true;
}

/** 均分各栏（清空 ratio，回到 canonical 的"不写主参数位"形态） */
export function equalizeColumns(editor: Editor): boolean {
  const block = findColumnGroup(editor);
  if (!block) return false;
  const group = block.node;
  const { schema } = editor.state;
  const columns: PMNode[] = [];
  let hadRatio = false;
  for (let i = 0; i < group.childCount; i++) {
    const col = group.child(i);
    if (col.attrs.ratio != null) hadRatio = true;
    columns.push(schema.nodes.column.create(null, col.content));
  }
  if (!hadRatio) return false; // 本来就均分，不产生空事务
  const tr = editor.state.tr;
  tr.replaceWith(block.pos, block.end, schema.nodes.columnGroup.create(group.attrs, columns));
  tr.setSelection(NodeSelection.create(tr.doc, block.pos));
  editor.view.dispatch(tr);
  return true;
}

// ── 作用于**当前选中**的段落格式 ────────────────────────────────────────────
//
// 与 TURN_INTO 的区别只在作用对象：TURN_INTO 服务于手柄菜单（对象是一个被
// NodeSelection 选中的块，所以要先把选区收进块内）；这里服务于浮动条，对象
// 就是当前选区本身——可能是一段文字，也可能是一片单元格（CellSelection 的
// ranges 覆盖每个单元格，setBlockType 会逐个作用过去）。
//
// 所以**不能**复用 TURN_INTO：它第一步就 setTextSelection，会把 CellSelection
// 拍扁成一个光标，整片单元格的选中当场没了。
//
// 展示位仍取自 BLOCK_TYPES —— 与 `/` 插入菜单、手柄的「转换为」共用同一张表。

// 这些 run 不调 focus()：浮动条的按钮已经 onMouseDown + preventDefault，
// 编辑器从没失过焦，focus() 是多余的。逐格施加时（applyAcrossCells）选区由
// 调用方逐格设好，这里只管执行命令。
export type FormatAction = {
  id: BlockTypeId;
  label: string;
  icon: string;
  run: (editor: Editor) => void;
  isActive: (editor: Editor) => boolean;
};

function format(
  id: BlockTypeId,
  run: (e: Editor) => void,
  isActive: (e: Editor) => boolean,
): FormatAction {
  const meta = BLOCK_TYPES[id];
  return { id, label: meta.label, icon: meta.icon, run, isActive };
}

export const FORMAT_ACTIONS: FormatAction[] = [
  format("paragraph",
    e => { e.chain().setParagraph().run(); },
    e => e.isActive("paragraph")),
  format("h2",
    e => { e.chain().setHeading({ level: 2 }).run(); },
    e => e.isActive("heading", { level: 2 })),
  format("h3",
    e => { e.chain().setHeading({ level: 3 }).run(); },
    e => e.isActive("heading", { level: 3 })),
  format("bulletList",
    e => { e.chain().toggleBulletList().run(); },
    e => e.isActive("bulletList")),
  format("orderedList",
    e => { e.chain().toggleOrderedList().run(); },
    e => e.isActive("orderedList")),
  format("taskList",
    e => { e.chain().toggleTaskList().run(); },
    e => e.isActive("taskList")),
  format("codeBlock",
    e => { e.chain().toggleCodeBlock().run(); },
    e => e.isActive("codeBlock")),
];

/** 当前选中处于哪种段落格式（给浮动条的 T 按钮显示用；都不中则给正文） */
export function currentFormat(editor: Editor): FormatAction {
  return FORMAT_ACTIONS.find(f => f.id !== "paragraph" && f.isActive(editor))
    ?? FORMAT_ACTIONS[0];
}
