// 表格的行/列操作 —— 服务于「表格外缘」那条操作带（components/editor/TableTools）。
//
// 编辑单位与分栏同构：**表格的单位是行与列，不是单元格里的块**。所以
//   · 单元格内部不给块级手柄（见 BlockHandle 的 scoreDragTarget）
//   · 外缘上点一段 = 选中整行/整列，随后的操作都作用于这个选中
//
// 选中用 prosemirror-tables 的 CellSelection：它是表格域的原生选中态，
// tiptap 的 addColumnBefore / deleteRow 这些命令读的就是它，所以选中之后
// 不需要为每个操作再算一次坐标。
import { CellSelection, TableMap, selectedRect } from "@tiptap/pm/tables";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

export type TableLoc = { node: PMNode; pos: number };

/** 光标/选中所处的表格（沿祖先上溯）。不在表里则 null */
export function findTable(editor: Editor): TableLoc | null {
  const $from = editor.state.selection.$from;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (node.type.name === "table") return { node, pos: $from.before(d) };
  }
  return null;
}

/** 表格的行列数 */
export function tableSize(table: PMNode): { rows: number; cols: number } {
  const map = TableMap.get(table);
  return { rows: map.height, cols: map.width };
}

/**
 * 选中整列 / 整行。
 *
 * TableMap 给的是**相对表格起点**的单元格偏移，所以要加上 tablePos + 1
 * （+1 跨过 table 自己的开标签）才是文档坐标——这一步漏了就会选到隔壁去。
 */
function selectCells(
  editor: Editor, table: TableLoc, kind: "col" | "row", index: number,
): boolean {
  const map = TableMap.get(table.node);
  const limit = kind === "col" ? map.width : map.height;
  if (index < 0 || index >= limit) return false;
  const base = table.pos + 1;

  const rect = kind === "col"
    ? { left: index, right: index + 1, top: 0, bottom: map.height }
    : { left: 0, right: map.width, top: index, bottom: index + 1 };
  const cells = map.cellsInRect(rect);
  if (cells.length === 0) return false;

  const { doc } = editor.state;
  const $anchor = doc.resolve(base + cells[0]);
  const $head = doc.resolve(base + cells[cells.length - 1]);
  const sel = kind === "col"
    ? CellSelection.colSelection($anchor, $head)
    : CellSelection.rowSelection($anchor, $head);
  editor.view.dispatch(editor.state.tr.setSelection(sel));
  return true;
}

export function selectColumn(editor: Editor, table: TableLoc, index: number): boolean {
  return selectCells(editor, table, "col", index);
}

export function selectRow(editor: Editor, table: TableLoc, index: number): boolean {
  return selectCells(editor, table, "row", index);
}

/**
 * 选中整张表（左上角那一格）。
 *
 * 这里落的是 NodeSelection，但**最终不会是** NodeSelection：prosemirror-tables
 * 的 tableEditing 插件会把整表的 NodeSelection 归一成覆盖全部单元格的
 * CellSelection。这是对的，不要绕开——表格域的命令（合并/拆分单元格、按选中
 * 删除行列）读的正是 CellSelection，归一之后它们才有作用对象。
 *
 * focus 必须在 setSelection **之前**：focus() 会把选区拨回它记下的那个位置，
 * 放在后面（或用 `chain().focus().setNodeSelection()`）都会把刚设好的选中冲掉。
 */
export function selectTable(editor: Editor, table: TableLoc): boolean {
  editor.commands.focus();
  const tr = editor.state.tr;
  try {
    tr.setSelection(NodeSelection.create(tr.doc, table.pos));
  } catch {
    return false;
  }
  editor.view.dispatch(tr);
  return true;
}

/**
 * 在第 index 条**列边界**处插一列（0 = 最左，cols = 最右）。
 *
 * tiptap 的 addColumnBefore/After 作用于"当前所在的单元格"，所以先把选中挪到
 * 边界旁边那一列，再跑命令。这也顺带给了用户视觉反馈：插完新列是选中的。
 */
export function insertColumnAtBoundary(editor: Editor, table: TableLoc, index: number): boolean {
  const { cols } = tableSize(table.node);
  if (index < 0 || index > cols) return false;
  if (index === cols) {
    if (!selectColumn(editor, table, cols - 1)) return false;
    return editor.chain().focus().addColumnAfter().run();
  }
  if (!selectColumn(editor, table, index)) return false;
  return editor.chain().focus().addColumnBefore().run();
}

/** 在第 index 条**行边界**处插一行（0 = 最上，rows = 最下） */
export function insertRowAtBoundary(editor: Editor, table: TableLoc, index: number): boolean {
  const { rows } = tableSize(table.node);
  if (index < 0 || index > rows) return false;
  if (index === rows) {
    if (!selectRow(editor, table, rows - 1)) return false;
    return editor.chain().focus().addRowAfter().run();
  }
  if (!selectRow(editor, table, index)) return false;
  return editor.chain().focus().addRowBefore().run();
}

// ── 行/列的破坏性操作 ──────────────────────────────────────────────────────
//
// 不做下拉菜单：插入已经由边界上的 ⊕ 承担，菜单里再放一遍「在左侧插入列」只是
// 同一件事的第二个入口（飞书、Notion 都因此没有这层菜单）。剩下的只有删除，
// 一个按钮的事，挂在选中的那条外缘上即可。

/** 删掉当前 CellSelection 覆盖的列 */
export function deleteSelectedColumn(editor: Editor): boolean {
  return editor.chain().focus().deleteColumn().run();
}

/** 删掉当前 CellSelection 覆盖的行 */
export function deleteSelectedRow(editor: Editor): boolean {
  return editor.chain().focus().deleteRow().run();
}

/** 清空选中单元格的内容（保留行列结构） */
export function clearSelectedCells(editor: Editor): boolean {
  return editor.chain().focus().deleteSelection().run();
}

// ── 行/列的搬移与复制 ──────────────────────────────────────────────────────
//
// 都要重建整张表：行/列的顺序是**结构**，没有哪个 attr 能表达它，只能换节点。
//
// 合并单元格的表一律拒绝：colspan/rowspan 让「第 i 列」不再是每行的第 i 个
// 子节点，按下标搬会把表撕烂。宁可不做，也不能做坏——这类破坏还不会立刻显形，
// 要等序列化成 GFM 时才炸。

/**
 * 首行是不是表头行。
 *
 * 这不是样式问题而是**存储问题**：正文存的是 GFM，而 GFM 表格强制要求首行
 * 是表头（`| --- |` 那行）。一旦表格没有首行表头，tiptap-markdown 只能退化成
 * 输出裸 <table> HTML——正文里混进 HTML，保真锁当场触发。
 *
 * 所以「表头行必须待在第一行」是硬约束，不是偏好。
 */
export function hasHeaderRow(table: PMNode): boolean {
  if (table.childCount === 0) return false;
  const first = table.child(0);
  return first.childCount > 0 && first.child(0).type.name === "tableHeader";
}

/** 表里有没有跨行跨列的单元格 */
export function hasMergedCells(table: PMNode): boolean {
  let merged = false;
  table.descendants(n => {
    if (merged) return false;
    const { colspan, rowspan } = n.attrs as { colspan?: number; rowspan?: number };
    if ((colspan ?? 1) > 1 || (rowspan ?? 1) > 1) merged = true;
    return !merged;
  });
  return merged;
}

/** 把 items 里第 from 项搬到**边界** to 处（to 与插入边界同一套编号） */
function reorder<T>(items: T[], from: number, to: number): T[] | null {
  if (from < 0 || from >= items.length) return null;
  const at = Math.max(0, Math.min(to, items.length));
  if (at === from || at === from + 1) return null; // 原地，不产生事务
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(at > from ? at - 1 : at, 0, moved);
  return next;
}

function replaceTable(editor: Editor, table: TableLoc, rows: PMNode[]): boolean {
  const tr = editor.state.tr;
  tr.replaceWith(table.pos, table.pos + table.node.nodeSize,
    table.node.type.create(table.node.attrs, rows));
  // 整张表被换掉了，旧选区会被映射到表**外面**——光标跳出表格是实打实的体验
  // 问题，而且后续操作靠选区找表（findTable），跳出去之后就再也接不上了
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(table.pos + 1)));
  } catch { /* 表被删空之类的极端情形，不强求 */ }
  editor.view.dispatch(tr);
  return true;
}

function rowsOf(table: PMNode): PMNode[] {
  const out: PMNode[] = [];
  for (let i = 0; i < table.childCount; i++) out.push(table.child(i));
  return out;
}

function cellsOf(row: PMNode): PMNode[] {
  const out: PMNode[] = [];
  for (let i = 0; i < row.childCount; i++) out.push(row.child(i));
  return out;
}

/**
 * 把第 from 行搬到边界 to 处。
 *
 * 表头行既不能被搬走、也不能被别的行挤到第二位——GFM 要求它待在第一行，
 * 否则整张表会退化成 HTML（见 hasHeaderRow）。
 */
export function moveRow(editor: Editor, table: TableLoc, from: number, to: number): boolean {
  if (hasMergedCells(table.node)) return false;
  if (hasHeaderRow(table.node) && (from === 0 || to === 0)) return false;
  const next = reorder(rowsOf(table.node), from, to);
  return next ? replaceTable(editor, table, next) : false;
}

/** 把第 from 列搬到边界 to 处 —— 每一行都要同样地搬一次 */
export function moveColumn(editor: Editor, table: TableLoc, from: number, to: number): boolean {
  if (hasMergedCells(table.node)) return false;
  const rows: PMNode[] = [];
  for (const row of rowsOf(table.node)) {
    const next = reorder(cellsOf(row), from, to);
    if (!next) return false;
    rows.push(row.type.create(row.attrs, next));
  }
  return replaceTable(editor, table, rows);
}

/** 复制第 index 行到它下面。表头行不给复制——GFM 只认一行表头 */
export function duplicateRow(editor: Editor, table: TableLoc, index: number): boolean {
  if (hasMergedCells(table.node)) return false;
  if (hasHeaderRow(table.node) && index === 0) return false;
  const rows = rowsOf(table.node);
  if (index < 0 || index >= rows.length) return false;
  rows.splice(index + 1, 0, rows[index]);
  return replaceTable(editor, table, rows);
}

/** 复制第 index 列到它右边 */
export function duplicateColumn(editor: Editor, table: TableLoc, index: number): boolean {
  if (hasMergedCells(table.node)) return false;
  const rows: PMNode[] = [];
  for (const row of rowsOf(table.node)) {
    const cells = cellsOf(row);
    if (index < 0 || index >= cells.length) return false;
    cells.splice(index + 1, 0, cells[index]);
    rows.push(row.type.create(row.attrs, cells));
  }
  return replaceTable(editor, table, rows);
}

// ── 「作用于当前选中」的包装 ────────────────────────────────────────────────
//
// 浮动条只知道"现在选中了一行/一列"，不知道是第几行第几列。selectedRect 把
// 这件事算好了（它正是 prosemirror-tables 自己那些命令用的东西），于是浮动条
// 不必再自己推坐标。

/** 当前选中所在的行列范围；不在表里则 null */
function rectOfSelection(editor: Editor) {
  try {
    return selectedRect(editor.state);
  } catch {
    return null;
  }
}

/** 选中是整行吗（外缘点出来的就是） */
export function isRowSelection(editor: Editor): boolean {
  const sel = editor.state.selection;
  return sel instanceof CellSelection && sel.isRowSelection();
}

/** 选中是整列吗 */
export function isColSelection(editor: Editor): boolean {
  const sel = editor.state.selection;
  return sel instanceof CellSelection && sel.isColSelection();
}

/** 复制当前选中的那一行 */
export function duplicateSelectedRow(editor: Editor): boolean {
  const t = findTable(editor);
  const r = rectOfSelection(editor);
  if (!t || !r) return false;
  return duplicateRow(editor, t, r.top);
}

/** 复制当前选中的那一列 */
export function duplicateSelectedColumn(editor: Editor): boolean {
  const t = findTable(editor);
  const r = rectOfSelection(editor);
  if (!t || !r) return false;
  return duplicateColumn(editor, t, r.left);
}
