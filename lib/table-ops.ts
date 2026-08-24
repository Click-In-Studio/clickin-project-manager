// 表格的行/列操作 —— 服务于「表格外缘」那条操作带（components/editor/TableTools）。
//
// 编辑单位与分栏同构：**表格的单位是行与列，不是单元格里的块**。所以
//   · 单元格内部不给块级手柄（见 BlockHandle 的 scoreDragTarget）
//   · 外缘上点一段 = 选中整行/整列，随后的操作都作用于这个选中
//
// 选中用 prosemirror-tables 的 CellSelection：它是表格域的原生选中态，
// tiptap 的 addColumnBefore / deleteRow 这些命令读的就是它，所以选中之后
// 不需要为每个操作再算一次坐标。
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { NodeSelection } from "@tiptap/pm/state";
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
 * CellSelection。这是对的，不要绕开——mergeCells / splitCell 这些命令读的正是
 * CellSelection，归一之后左上角菜单里的操作才有作用对象。
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

// ── 外缘点开的菜单 ───────────────────────────────────────────────────────────

export type TableAction = {
  id: string;
  label: string;
  danger?: boolean;
  run: (editor: Editor) => void;
};

/** 选中某一列之后能做什么 */
export const COLUMN_ACTIONS: TableAction[] = [
  { id: "before", label: "在左侧插入列", run: e => { e.chain().focus().addColumnBefore().run(); } },
  { id: "after", label: "在右侧插入列", run: e => { e.chain().focus().addColumnAfter().run(); } },
  { id: "headerCol", label: "切换表头列", run: e => { e.chain().focus().toggleHeaderColumn().run(); } },
  { id: "delete", label: "删除列", danger: true, run: e => { e.chain().focus().deleteColumn().run(); } },
];

/** 选中某一行之后能做什么 */
export const ROW_ACTIONS: TableAction[] = [
  { id: "before", label: "在上方插入行", run: e => { e.chain().focus().addRowBefore().run(); } },
  { id: "after", label: "在下方插入行", run: e => { e.chain().focus().addRowAfter().run(); } },
  { id: "headerRow", label: "切换表头行", run: e => { e.chain().focus().toggleHeaderRow().run(); } },
  { id: "delete", label: "删除行", danger: true, run: e => { e.chain().focus().deleteRow().run(); } },
];

/** 左上角（整张表）能做什么 */
export const TABLE_ACTIONS: TableAction[] = [
  { id: "mergeCells", label: "合并单元格", run: e => { e.chain().focus().mergeCells().run(); } },
  { id: "splitCell", label: "拆分单元格", run: e => { e.chain().focus().splitCell().run(); } },
  { id: "deleteTable", label: "删除表格", danger: true, run: e => { e.chain().focus().deleteTable().run(); } },
];
