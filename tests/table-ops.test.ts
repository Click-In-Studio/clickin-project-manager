// @vitest-environment jsdom
// 表格行/列操作（服务于表格外缘）。
//
// 几何（外缘各段的位置）吃 DOM 矩形，jsdom 没布局测不了；但**选中了哪一行/
// 哪一列、插到了第几条边界**是纯逻辑，而这正是会静默错位的地方——TableMap
// 给的是相对表格起点的偏移，忘了加 tablePos+1 就会选到隔壁去，界面上看不出来。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { CellSelection } from "@tiptap/pm/tables";
import {
  findTable, tableSize, selectColumn, selectRow, selectTable,
  insertColumnAtBoundary, insertRowAtBoundary,
  COLUMN_ACTIONS, ROW_ACTIONS, TABLE_ACTIONS,
} from "@/lib/table-ops";

function makeEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ transformCopiedText: true, breaks: true }),
      TableKit.configure({ table: { resizable: false } }),
    ],
    content,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const md = (e: Editor) => (e.storage as any).markdown.getMarkdown() as string;

/** 3 列 × 3 行（含表头行） */
const T3 = [
  "| a | b | c |",
  "| --- | --- | --- |",
  "| 1 | 2 | 3 |",
  "| 4 | 5 | 6 |",
].join("\n");

/** 把光标放进表格里（外缘操作的前提：先能找到表） */
function focusInTable(e: Editor) {
  let pos = -1;
  e.state.doc.descendants((n, p) => { if (n.type.name === "table" && pos < 0) { pos = p; return false; } });
  e.commands.setTextSelection(pos + 4); // 第一个单元格内部
  return pos;
}

/** 当前 CellSelection 覆盖的单元格文本 */
function selectedCellTexts(e: Editor): string[] {
  const sel = e.state.selection;
  if (!(sel instanceof CellSelection)) return [];
  const out: string[] = [];
  sel.forEachCell(cell => out.push(cell.textContent));
  return out;
}

describe("findTable / tableSize", () => {
  it("光标在表里能找到表；不在表里给 null", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    const t = findTable(e);
    expect(t).not.toBeNull();
    expect(tableSize(t!.node)).toEqual({ rows: 3, cols: 3 });
    e.destroy();

    const p = makeEditor("甲");
    p.commands.setTextSelection(1);
    expect(findTable(p)).toBeNull();
    p.destroy();
  });
});

describe("选中整行 / 整列", () => {
  it("选中第 0 列 = 该列全部单元格（不是隔壁那列）", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    const t = findTable(e)!;
    expect(selectColumn(e, t, 0)).toBe(true);
    expect(selectedCellTexts(e)).toEqual(["a", "1", "4"]);
    e.destroy();
  });

  it("选中中间一列、最后一列", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    const t = findTable(e)!;
    selectColumn(e, t, 1);
    expect(selectedCellTexts(e)).toEqual(["b", "2", "5"]);
    selectColumn(e, findTable(e)!, 2);
    expect(selectedCellTexts(e)).toEqual(["c", "3", "6"]);
    e.destroy();
  });

  it("选中某一行 = 该行全部单元格", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    const t = findTable(e)!;
    expect(selectRow(e, t, 1)).toBe(true);
    expect(selectedCellTexts(e)).toEqual(["1", "2", "3"]);
    e.destroy();
  });

  it("下标越界一律拒绝，且不动选中", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    const t = findTable(e)!;
    expect(selectColumn(e, t, -1)).toBe(false);
    expect(selectColumn(e, t, 3)).toBe(false);
    expect(selectRow(e, t, 3)).toBe(false);
    expect(e.state.selection instanceof CellSelection).toBe(false);
    e.destroy();
  });

  // 我们设的是 NodeSelection，但 prosemirror-tables 的 tableEditing 插件会把它
  // 归一成覆盖全部单元格的 CellSelection。这是对的：mergeCells / splitCell 读的
  // 正是 CellSelection，归一之后左上角菜单里的操作才有作用对象
  it("选中整张表 = 覆盖全部单元格的 CellSelection", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(selectTable(e, findTable(e)!)).toBe(true);
    expect(e.state.selection instanceof CellSelection).toBe(true);
    expect(selectedCellTexts(e).sort()).toEqual(
      ["1", "2", "3", "4", "5", "6", "a", "b", "c"],
    );
    e.destroy();
  });
});

describe("按边界插入行/列", () => {
  /** 表格第一行的单元格文本，用来判断列插到了哪 */
  function headerCells(e: Editor): string[] {
    const out: string[] = [];
    e.state.doc.descendants(n => {
      if (n.type.name !== "tableRow" || out.length) return;
      n.forEach(cell => out.push(cell.textContent));
      return false;
    });
    return out;
  }

  it.each([0, 1, 2, 3])("列边界 %i：新列正好落在第 i 位", (b) => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(insertColumnAtBoundary(e, findTable(e)!, b)).toBe(true);
    expect(tableSize(findTable(e)!.node).cols).toBe(4);
    const cells = headerCells(e);
    expect(cells).toHaveLength(4);
    expect(cells[b]).toBe(""); // 空的那格就是新列
    e.destroy();
  });

  it.each([0, 1, 2, 3])("行边界 %i：新行正好落在第 i 位", (b) => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(insertRowAtBoundary(e, findTable(e)!, b)).toBe(true);
    expect(tableSize(findTable(e)!.node).rows).toBe(4);
    const rows: string[][] = [];
    e.state.doc.descendants(n => {
      if (n.type.name !== "tableRow") return;
      const cells: string[] = [];
      n.forEach(c => cells.push(c.textContent));
      rows.push(cells);
      return false;
    });
    expect(rows).toHaveLength(4);
    expect(rows[b].join("")).toBe(""); // 空的那行就是新行
    e.destroy();
  });

  it("边界越界拒绝", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    const t = findTable(e)!;
    expect(insertColumnAtBoundary(e, t, -1)).toBe(false);
    expect(insertColumnAtBoundary(e, t, 4)).toBe(false);
    expect(insertRowAtBoundary(e, t, 4)).toBe(false);
    expect(tableSize(findTable(e)!.node)).toEqual({ rows: 3, cols: 3 });
    e.destroy();
  });

  it("插完仍是合法 GFM 表格，且可逐字往返", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    insertColumnAtBoundary(e, findTable(e)!, 1);
    insertRowAtBoundary(e, findTable(e)!, 2);
    const produced = md(e);
    expect(produced).toMatch(/\|\s*-+/); // 表头分隔行还在
    e.destroy();
    const again = makeEditor(produced);
    expect(md(again)).toBe(produced);
    again.destroy();
  });
});

describe("外缘菜单的动作表", () => {
  it("三张表的 id 各自不重复（菜单按 id 做 key）", () => {
    for (const list of [COLUMN_ACTIONS, ROW_ACTIONS, TABLE_ACTIONS]) {
      expect(new Set(list.map(a => a.id)).size).toBe(list.length);
    }
  });

  it("删除类动作都标了 danger（红色是唯一的破坏性提示）", () => {
    expect(COLUMN_ACTIONS.find(a => a.id === "delete")?.danger).toBe(true);
    expect(ROW_ACTIONS.find(a => a.id === "delete")?.danger).toBe(true);
    expect(TABLE_ACTIONS.find(a => a.id === "deleteTable")?.danger).toBe(true);
  });

  it("删除列真的少一列", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectColumn(e, findTable(e)!, 1);
    COLUMN_ACTIONS.find(a => a.id === "delete")!.run(e);
    expect(tableSize(findTable(e)!.node).cols).toBe(2);
    expect(md(e)).not.toContain("b");
    e.destroy();
  });

  it("删除行真的少一行", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 1);
    ROW_ACTIONS.find(a => a.id === "delete")!.run(e);
    expect(tableSize(findTable(e)!.node).rows).toBe(2);
    e.destroy();
  });

  it("删除表格之后正文里没有表", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    TABLE_ACTIONS.find(a => a.id === "deleteTable")!.run(e);
    expect(findTable(e)).toBeNull();
    expect(md(e)).not.toContain("|");
    e.destroy();
  });
});
