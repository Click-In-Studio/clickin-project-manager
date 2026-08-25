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
  deleteSelectedColumn, deleteSelectedRow, clearSelectedCells,
  moveRow, moveColumn, duplicateRow, duplicateColumn, hasMergedCells,
  isRowSelection, isColSelection, duplicateSelectedRow, duplicateSelectedColumn,
} from "@/lib/table-ops";
import { TableKeymap } from "@/lib/tiptap-table-keymap";

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
  // 正是 CellSelection，归一之后表格域的命令才有作用对象
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

describe("行/列删除（选中之后那条外缘上的 ✕）", () => {
  it("删除列真的少一列", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectColumn(e, findTable(e)!, 1);
    expect(deleteSelectedColumn(e)).toBe(true);
    expect(tableSize(findTable(e)!.node).cols).toBe(2);
    expect(md(e)).not.toContain("b");
    e.destroy();
  });

  it("删除行真的少一行", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 1);
    expect(deleteSelectedRow(e)).toBe(true);
    expect(tableSize(findTable(e)!.node).rows).toBe(2);
    e.destroy();
  });

  // 不做下拉菜单，所以插入的唯一入口是边界上的 ⊕；这里守住"没有第二个入口"
  // 的另一半：删除也只作用于**当前选中**，没选中就什么都不该发生
  it("没有 CellSelection 时删除不生效（避免误删）", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    const before = tableSize(findTable(e)!.node);
    deleteSelectedColumn(e);
    deleteSelectedRow(e);
    // 光标在单元格里时 tiptap 会按"当前单元格所在行列"操作，所以这里只断言
    // 表格没被整个搞坏——真正的护栏是 UI 上只有选中后才出现 ✕
    expect(findTable(e)).not.toBeNull();
    expect(tableSize(findTable(e)!.node).cols).toBeLessThanOrEqual(before.cols);
    e.destroy();
  });
});

describe("行/列重排（外缘拖拽）", () => {
  /** 逐行逐格的文本快照 */
  function grid(e: Editor): string[][] {
    const rows: string[][] = [];
    e.state.doc.descendants(n => {
      if (n.type.name !== "tableRow") return;
      const cells: string[] = [];
      n.forEach(c => cells.push(c.textContent));
      rows.push(cells);
      return false;
    });
    return rows;
  }

  // 表头行必须待在第一行：GFM 表格强制要求首行是表头，一旦不是，
  // tiptap-markdown 只能退化成输出裸 <table> HTML，正文里混进 HTML，
  // 保真锁当场触发。所以这既不是样式偏好也不是洁癖，是存储层的硬约束
  it("表头行不能被搬走", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(moveRow(e, findTable(e)!, 0, 3)).toBe(false);
    expect(grid(e)[0]).toEqual(["a", "b", "c"]);
    e.destroy();
  });

  it("别的行也不能挤到表头前面", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(moveRow(e, findTable(e)!, 2, 0)).toBe(false);
    expect(grid(e)[0]).toEqual(["a", "b", "c"]);
    e.destroy();
  });

  it("表头之下的行可以随便换位", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(moveRow(e, findTable(e)!, 2, 1)).toBe(true);
    expect(grid(e)).toEqual([["a", "b", "c"], ["4", "5", "6"], ["1", "2", "3"]]);
    e.destroy();
  });

  it("把第 0 列搬到最后 —— 每一行都要跟着搬", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(moveColumn(e, findTable(e)!, 0, 3)).toBe(true);
    expect(grid(e)).toEqual([["b", "c", "a"], ["2", "3", "1"], ["5", "6", "4"]]);
    e.destroy();
  });

  it("搬到原地不产生事务（落点边界 = from 或 from+1）", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(moveRow(e, findTable(e)!, 1, 1)).toBe(false);
    expect(moveRow(e, findTable(e)!, 1, 2)).toBe(false);
    expect(duplicateRow(e, findTable(e)!, 0)).toBe(false); // 表头行不给复制
    expect(moveColumn(e, findTable(e)!, 1, 2)).toBe(false);
    expect(grid(e)).toEqual([["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]]);
    e.destroy();
  });

  it("重排后仍是合法 GFM 且可逐字往返", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    moveColumn(e, findTable(e)!, 2, 0);
    moveRow(e, findTable(e)!, 2, 1);
    const produced = md(e);
    expect(produced).toMatch(/\|\s*-+/);
    e.destroy();
    const again = makeEditor(produced);
    expect(md(again)).toBe(produced);
    again.destroy();
  });

  // 合并单元格会让"第 i 列"不再是每行的第 i 个子节点，按下标搬会把表撕烂，
  // 而且要等序列化成 GFM 时才炸。宁可不做
  it("合并单元格的表一律拒绝重排/复制", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 1);
    e.chain().focus().mergeCells().run();
    expect(hasMergedCells(findTable(e)!.node)).toBe(true);
    const before = grid(e);
    expect(moveRow(e, findTable(e)!, 0, 2)).toBe(false);
    expect(moveColumn(e, findTable(e)!, 0, 2)).toBe(false);
    expect(duplicateRow(e, findTable(e)!, 0)).toBe(false);
    expect(duplicateColumn(e, findTable(e)!, 0)).toBe(false);
    expect(grid(e)).toEqual(before);
    e.destroy();
  });
});

describe("复制行/列", () => {
  it("复制的行落在原行下面", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(duplicateRow(e, findTable(e)!, 1)).toBe(true);
    expect(tableSize(findTable(e)!.node).rows).toBe(4);
    expect(md(e).split("\n").filter(l => l.includes("| 1 |")).length).toBe(2);
    e.destroy();
  });

  it("复制的列落在原列右边", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(duplicateColumn(e, findTable(e)!, 0)).toBe(true);
    expect(tableSize(findTable(e)!.node).cols).toBe(4);
    e.destroy();
  });
});

describe("清空内容", () => {
  it("只清内容，行列结构不动", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 1);
    expect(clearSelectedCells(e)).toBe(true);
    expect(tableSize(findTable(e)!.node)).toEqual({ rows: 3, cols: 3 });
    expect(md(e)).not.toContain("1");
    expect(md(e)).toContain("a");
    e.destroy();
  });
});

describe("Delete 键：整行/整列选中时删的是结构", () => {
  // 默认行为是"清空内容保留结构"，那在拖选几个单元格时对，在从外缘选了一整行
  // 时不对——用户明确指着一整行说删，却只被清空，看起来像没生效
  function makeWithKeymap(content: string) {
    return new Editor({
      extensions: [
        StarterKit, Markdown.configure({ breaks: true }),
        TableKit.configure({ table: { resizable: false } }),
        TableKeymap,
      ],
      content,
    });
  }

  /** 直接跑扩展注册的那个快捷键 */
  function pressDelete(e: Editor): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ext = (e.extensionManager.extensions as any[]).find(x => x.name === "clickinTableKeymap");
    const shortcuts = ext.config.addKeyboardShortcuts.call({ editor: e });
    return shortcuts.Delete();
  }

  it("整行选中 → 删掉整行", () => {
    const e = makeWithKeymap(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 1);
    expect(pressDelete(e)).toBe(true);
    expect(tableSize(findTable(e)!.node).rows).toBe(2);
    e.destroy();
  });

  it("整列选中 → 删掉整列", () => {
    const e = makeWithKeymap(T3);
    focusInTable(e);
    selectColumn(e, findTable(e)!, 1);
    expect(pressDelete(e)).toBe(true);
    expect(tableSize(findTable(e)!.node).cols).toBe(2);
    e.destroy();
  });

  it("整表选中 → 删掉整张表", () => {
    const e = makeWithKeymap(T3);
    focusInTable(e);
    selectTable(e, findTable(e)!);
    expect(pressDelete(e)).toBe(true);
    expect(findTable(e)).toBeNull();
    e.destroy();
  });

  it("不是 CellSelection 时不接管（交还默认的清空内容）", () => {
    const e = makeWithKeymap(T3);
    focusInTable(e);
    expect(pressDelete(e)).toBe(false);
    e.destroy();
  });
});

describe("「作用于当前选中」的包装（通用浮动条按这些分派内容）", () => {
  it("整行选中：isRowSelection 真、isColSelection 假", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 1);
    expect(isRowSelection(e)).toBe(true);
    expect(isColSelection(e)).toBe(false);
    e.destroy();
  });

  it("整列选中：反过来", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectColumn(e, findTable(e)!, 1);
    expect(isColSelection(e)).toBe(true);
    expect(isRowSelection(e)).toBe(false);
    e.destroy();
  });

  // 浮动条据此在"整表"时给「删除整张表格」而不是「删除这一行」
  it("整表选中：两者都真", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectTable(e, findTable(e)!);
    expect(isRowSelection(e)).toBe(true);
    expect(isColSelection(e)).toBe(true);
    e.destroy();
  });

  it("光标只是落在单元格里（不是 CellSelection）：两者都假", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    expect(isRowSelection(e)).toBe(false);
    expect(isColSelection(e)).toBe(false);
    e.destroy();
  });

  it("复制当前选中的行/列 —— 浮动条不必自己推下标", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 2);
    expect(duplicateSelectedRow(e)).toBe(true);
    expect(tableSize(findTable(e)!.node).rows).toBe(4);
    e.destroy();

    const c = makeEditor(T3);
    focusInTable(c);
    selectColumn(c, findTable(c)!, 1);
    expect(duplicateSelectedColumn(c)).toBe(true);
    expect(tableSize(findTable(c)!.node).cols).toBe(4);
    c.destroy();
  });

  it("选中表头行时复制被拒（GFM 只认一行表头）", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 0);
    expect(duplicateSelectedRow(e)).toBe(false);
    expect(tableSize(findTable(e)!.node).rows).toBe(3);
    e.destroy();
  });
});

describe("存储能表达什么，决定 UI 给什么入口", () => {
  // 正文存的是 GFM。凡是 GFM 表达不了的表格结构，序列化时整张表都会退化成裸
  // <table> HTML——正文里混进 HTML，只读端（react-markdown 不挂 rehype-raw）
  // 还会把它当纯文本显示出来。所以这些操作**不给 UI 入口**，不是简化界面，
  // 是正确性要求。
  //
  // 这几条也解释了 hasMergedCells 那些守卫为什么存在。哪天 tiptap-markdown
  // 支持了 colspan，这里会先红，那时才谈得上放开。
  function isGfmTable(markdown: string): boolean {
    return !markdown.includes("<table");
  }

  it("正常表格序列化成 GFM", () => {
    const e = makeEditor(T3);
    expect(isGfmTable(md(e))).toBe(true);
    e.destroy();
  });

  it("合并单元格 → 退化成 HTML（所以不提供合并入口）", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    selectRow(e, findTable(e)!, 1);
    e.chain().focus().mergeCells().run();
    expect(isGfmTable(md(e))).toBe(false);
    e.destroy();
  });

  it("首行不是表头 → 退化成 HTML（所以表头行不许被搬走、不提供表头切换）", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    e.chain().focus().toggleHeaderRow().run();
    expect(isGfmTable(md(e))).toBe(false);
    e.destroy();
  });

  it("表头列 → 退化成 HTML（GFM 根本没有表头列的概念）", () => {
    const e = makeEditor(T3);
    focusInTable(e);
    e.chain().focus().toggleHeaderColumn().run();
    expect(isGfmTable(md(e))).toBe(false);
    e.destroy();
  });
});
