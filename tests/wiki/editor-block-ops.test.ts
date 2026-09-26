// @vitest-environment jsdom
// 块级操作（调研文档 §4.2 步骤 3）行为测试。
//
// 重点不是「点了有没有反应」，而是**操作后序列化成什么**。块操作最阴的失败
// 模式是结构被改坏、但要等用户下次保存才暴露成保真锁告警——所以每个操作都
// 断言落地的 markdown，而不是断言 doc 的 JSON。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Markdown } from "tiptap-markdown";
import { NodeSelection } from "@tiptap/pm/state";
import { Callout } from "@/lib/editor/tiptap-callout";
import { Column, ColumnGroup } from "@/lib/editor/tiptap-columns";
import {
  getSelectedBlock, moveBlock, duplicateBlock, deleteBlock,
  turnInto, canTurnInto, isColumnGroup, changeColumnCount, equalizeColumns,
  findColumnGroup, selectColumnGroup,
  findCallout, setCalloutColor, setCalloutEmoji,
  FORMAT_ACTIONS, currentFormat,
} from "@/lib/editor/editor-block-ops";
import { ColumnEditing, isEmptyColumn } from "@/lib/editor/tiptap-column-editing";

function makeEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ transformCopiedText: true, breaks: true }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList, TaskItem.configure({ nested: true }),
      Callout, Column, ColumnGroup, ColumnEditing,
    ],
    content,
  });
}

/** 选中第 index 栏（等价于用户点了那一栏的 ⠿ 手柄——分栏里的拖拽单位是栏） */
function selectColumn(editor: Editor, groupPos: number, index: number) {
  const group = editor.state.doc.nodeAt(groupPos)!;
  let pos = groupPos + 1;
  for (let i = 0; i < index; i++) pos += group.child(i).nodeSize;
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const md = (e: Editor) => (e.storage as any).markdown.getMarkdown() as string;

/** 选中第 index 个顶层块（等价于用户点了那个块的 ⠿ 手柄） */
function selectTopBlock(editor: Editor, index: number) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}

describe("getSelectedBlock", () => {
  it("非整块选中时给 null —— 所有块操作据此拒绝执行", () => {
    const e = makeEditor("甲\n\n乙");
    e.commands.setTextSelection(2);
    expect(getSelectedBlock(e)).toBeNull();
    expect(moveBlock(e, -1)).toBe(false);
    expect(duplicateBlock(e)).toBe(false);
    expect(deleteBlock(e)).toBe(false);
    e.destroy();
  });
});

describe("移动 / 复制 / 删除", () => {
  it("上移换位，且移完仍保持整块选中（连按两下才不用重新点手柄）", () => {
    const e = makeEditor("甲\n\n乙\n\n丙");
    selectTopBlock(e, 1);
    expect(moveBlock(e, -1)).toBe(true);
    expect(md(e)).toBe("乙\n\n甲\n\n丙");
    const still = getSelectedBlock(e);
    expect(still?.node.textContent).toBe("乙");
    e.destroy();
  });

  it("下移换位", () => {
    const e = makeEditor("甲\n\n乙\n\n丙");
    selectTopBlock(e, 1);
    expect(moveBlock(e, 1)).toBe(true);
    expect(md(e)).toBe("甲\n\n丙\n\n乙");
    e.destroy();
  });

  it("连按上移两次走到顶，再按一次拒绝且文档不变", () => {
    const e = makeEditor("甲\n\n乙\n\n丙");
    selectTopBlock(e, 2);
    expect(moveBlock(e, -1)).toBe(true);
    expect(moveBlock(e, -1)).toBe(true);
    expect(md(e)).toBe("丙\n\n甲\n\n乙");
    expect(moveBlock(e, -1)).toBe(false);
    expect(md(e)).toBe("丙\n\n甲\n\n乙");
    e.destroy();
  });

  it("末块下移被拒绝，文档不变", () => {
    const e = makeEditor("甲\n\n乙");
    selectTopBlock(e, 1);
    expect(moveBlock(e, 1)).toBe(false);
    expect(md(e)).toBe("甲\n\n乙");
    e.destroy();
  });

  it("复制落在原块正下方，并选中新的那份", () => {
    const e = makeEditor("甲\n\n乙");
    selectTopBlock(e, 0);
    expect(duplicateBlock(e)).toBe(true);
    expect(md(e)).toBe("甲\n\n甲\n\n乙");
    e.destroy();
  });

  it("删除整块", () => {
    const e = makeEditor("甲\n\n乙\n\n丙");
    selectTopBlock(e, 1);
    expect(deleteBlock(e)).toBe(true);
    expect(md(e)).toBe("甲\n\n丙");
    e.destroy();
  });

  // review 点名的高风险路径：下移那一支原先是手算落点。现在两个方向都走
  // tr.mapping，这条盯住"下移之后正文仍能逐字往返"
  it("下移之后落地形态仍可逐字往返", () => {
    const e = makeEditor("甲\n\n## 乙\n\n> 丙");
    selectTopBlock(e, 0);
    expect(moveBlock(e, 1)).toBe(true);
    const produced = md(e);
    expect(produced).toBe("## 乙\n\n甲\n\n> 丙");
    e.destroy();
    const again = makeEditor(produced);
    expect(md(again)).toBe(produced);
    again.destroy();
  });

  it("下移带方言的块（分栏整组）后 fence 完好", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::\n\n甲");
    selectTopBlock(e, 0);
    expect(moveBlock(e, 1)).toBe(true);
    const out = md(e);
    expect(out.startsWith("甲")).toBe(true);
    expect(out).toContain(":::cols");
    expect(out).toContain("\n---\n");
    e.destroy();
    const again = makeEditor(out);
    expect(md(again)).toBe(out);
    again.destroy();
  });

  it("带方言的块移动后形态不变（分栏整组上移，fence 完好）", () => {
    const e = makeEditor("甲\n\n:::cols\n\n左\n\n---\n\n右\n\n:::");
    const before = md(e);
    selectTopBlock(e, 1);
    expect(isColumnGroup(getSelectedBlock(e)!.node)).toBe(true);
    expect(moveBlock(e, -1)).toBe(true);
    const after = md(e);
    expect(after.startsWith(":::cols")).toBe(true);
    expect(after.trimEnd().endsWith("甲")).toBe(true);
    // 组内结构逐字保留，只是换了位置
    expect(after).toContain("左");
    expect(after).toContain("右");
    expect(after).toContain("\n---\n");
    expect(before).toContain("\n---\n");
    e.destroy();
  });
});

describe("转换类型", () => {
  it("段落可转一级标题", () => {
    const e = makeEditor("甲\n\n乙");
    selectTopBlock(e, 0);
    expect(turnInto(e, "h1")).toBe(true);
    expect(md(e)).toBe("# 甲\n\n乙");
    e.destroy();
  });

  it("段落转引用 / 转高亮块都落 canonical 形态", () => {
    const q = makeEditor("甲");
    selectTopBlock(q, 0);
    turnInto(q, "blockquote");
    expect(md(q)).toBe("> 甲");
    q.destroy();

    const c = makeEditor("甲");
    selectTopBlock(c, 0);
    turnInto(c, "callout");
    expect(md(c)).toBe("> [!💡]\n> 甲");
    c.destroy();
  });

  it("结构型节点不给转换 —— 把分栏组变成标题没有意义", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    selectTopBlock(e, 0);
    const before = md(e);
    expect(canTurnInto(getSelectedBlock(e)!.node)).toBe(false);
    expect(turnInto(e, "h2")).toBe(false);
    expect(md(e)).toBe(before);
    e.destroy();
  });

  // review 点名：原先无条件返回 true，把 chain().run() 的成败丢掉了。
  // 顺带记下一个真实行为——turnInto 会把整块选中收敛成块内文本光标（那些
  // 命令吃的是文本选区），所以**连着调第二次必然失败**，除非重新选中。
  // UI 上无碍（手柄菜单点完就关），但接口语义得说清楚
  it("返回底层命令的真实成败；且它会吃掉整块选中", () => {
    const e = makeEditor("甲");
    selectTopBlock(e, 0);
    expect(turnInto(e, "h2")).toBe(true);
    expect(md(e)).toBe("## 甲");
    // 选中已经不是 NodeSelection 了，第二次直接被 getSelectedBlock 挡回来
    expect(getSelectedBlock(e)).toBeNull();
    expect(turnInto(e, "h3")).toBe(false);
    expect(md(e)).toBe("## 甲");
    // 重新选中之后照常可用
    selectTopBlock(e, 0);
    expect(turnInto(e, "h3")).toBe(true);
    expect(md(e)).toBe("### 甲");
    e.destroy();
  });

  it("未知 optionId 拒绝执行", () => {
    const e = makeEditor("甲");
    selectTopBlock(e, 0);
    expect(turnInto(e, "nope")).toBe(false);
    e.destroy();
  });
});

describe("段落格式菜单", () => {
  it("一级标题可选，并能识别当前一级标题", () => {
    expect(FORMAT_ACTIONS.map(action => action.id).slice(0, 4)).toEqual([
      "paragraph", "h1", "h2", "h3",
    ]);
    const e = makeEditor("# 甲");
    e.commands.setTextSelection(2);
    expect(currentFormat(e).id).toBe("h1");
    e.destroy();
  });
});

describe("分栏增删栏", () => {
  it("加一栏 —— 新栏在末尾，原有内容不动", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    selectTopBlock(e, 0);
    expect(changeColumnCount(e, 1)).toBe(true);
    const out = md(e);
    expect(out).toContain("左");
    expect(out).toContain("右");
    // 两个分隔符 = 三栏
    expect(out.match(/\n---\n/g)?.length).toBe(2);
    e.destroy();
  });

  it("减一栏", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n中\n\n---\n\n右\n\n:::");
    selectTopBlock(e, 0);
    expect(changeColumnCount(e, -1)).toBe(true);
    const out = md(e);
    expect(out.match(/\n---\n/g)?.length).toBe(1);
    expect(out).toContain("左");
    expect(out).toContain("中");
    expect(out).not.toContain("右"); // 从末尾减
    e.destroy();
  });

  it("两栏时拒绝再减 —— content 是 `column column+`，一栏组不成立", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    selectTopBlock(e, 0);
    const before = md(e);
    expect(changeColumnCount(e, -1)).toBe(false);
    expect(md(e)).toBe(before);
    e.destroy();
  });

  it("栏数变化后清空 ratio，回到不写主参数位的 canonical 形态", () => {
    const e = makeEditor(":::cols 40,60\n\n左\n\n---\n\n右\n\n:::");
    selectTopBlock(e, 0);
    expect(md(e)).toContain(":::cols 40,60"); // 前提：宽度确实被解析进来了
    expect(changeColumnCount(e, 1)).toBe(true);
    const out = md(e);
    expect(out).not.toMatch(/:::cols\s+\d/);
    expect(out.startsWith(":::cols\n")).toBe(true);
    e.destroy();
  });

  it("均分清空 ratio；本来就均分则不产生事务", () => {
    const e = makeEditor(":::cols 40,60\n\n左\n\n---\n\n右\n\n:::");
    selectTopBlock(e, 0);
    expect(equalizeColumns(e)).toBe(true);
    expect(md(e)).not.toMatch(/:::cols\s+\d/);
    expect(equalizeColumns(e)).toBe(false);
    e.destroy();
  });

  it("光标在栏内某块时，分栏操作沿祖先够到组（手柄已不再把组作为目标）", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    e.commands.setTextSelection(3); // 落在第一栏的「左」里
    expect(getSelectedBlock(e)).toBeNull(); // 不是整块选中
    const g = findColumnGroup(e);
    expect(g).not.toBeNull();
    expect(isColumnGroup(g!.node)).toBe(true);
    expect(changeColumnCount(e, 1)).toBe(true);
    expect(md(e).match(/\n---\n/g)?.length).toBe(2);
    e.destroy();
  });

  it("「整组」把选中提升到祖先分栏组，之后 ↑↓/删除作用于整组", () => {
    const e = makeEditor("甲\n\n:::cols\n\n左\n\n---\n\n右\n\n:::");
    // 落到第二个顶层块（分栏组）第一栏的文字里
    const groupPos = e.state.doc.child(0).nodeSize;
    e.commands.setTextSelection(groupPos + 3);
    expect(selectColumnGroup(e)).toBe(true);
    const sel = getSelectedBlock(e);
    expect(sel).not.toBeNull();
    expect(isColumnGroup(sel!.node)).toBe(true);
    // 整组上移
    expect(moveBlock(e, -1)).toBe(true);
    expect(md(e).startsWith(":::cols")).toBe(true);
    e.destroy();
  });

  it("不在任何分栏组里时 findColumnGroup 给 null、「整组」拒绝", () => {
    const e = makeEditor("甲");
    e.commands.setTextSelection(1);
    expect(findColumnGroup(e)).toBeNull();
    expect(selectColumnGroup(e)).toBe(false);
    e.destroy();
  });

  it("选中一整栏后删除 → 两栏组被拆掉，剩下那栏的内容原地保留", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    selectColumn(e, 0, 0);
    expect(getSelectedBlock(e)!.node.type.name).toBe("column");
    expect(deleteBlock(e)).toBe(true);
    // 组不足两栏就不成立 → 拆组；内容不能丢
    expect(md(e)).toBe("右");
    e.destroy();
  });

  it("三栏里删一栏 → 还剩两栏，组仍在", () => {
    const e = makeEditor(":::cols\n\n一\n\n---\n\n二\n\n---\n\n三\n\n:::");
    selectColumn(e, 0, 1);
    expect(deleteBlock(e)).toBe(true);
    const out = md(e);
    expect(out.startsWith(":::cols")).toBe(true);
    expect(out.match(/\n---\n/g)?.length).toBe(1);
    expect(out).toContain("一");
    expect(out).toContain("三");
    expect(out).not.toContain("二");
    e.destroy();
  });

  it("栏之间可以用 ↑↓ 换位（同一父节点内换位，父节点就是分栏组）", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    selectColumn(e, 0, 1);
    expect(moveBlock(e, -1)).toBe(true);
    const [first, second] = md(e).split("\n---\n");
    expect(first).toContain("右");
    expect(second).toContain("左");
    e.destroy();
  });

  it("空栏不会被自动回收 —— 新建的栏天生就是空的", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    selectColumn(e, 0, 0);
    // 清空第一栏的内容（模拟用户把里面的字删光）
    const col = getSelectedBlock(e)!;
    e.view.dispatch(e.state.tr.delete(col.pos + 2, col.end - 2));
    expect(isEmptyColumn(e.state.doc.nodeAt(0)!.child(0))).toBe(true);
    // 组还在、还是两栏
    expect(md(e).startsWith(":::cols")).toBe(true);
    expect(e.state.doc.nodeAt(0)!.childCount).toBe(2);
    e.destroy();
  });

  it("光标在栏内某块时，分栏操作沿祖先够到组", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    e.commands.setTextSelection(3);
    const g = findColumnGroup(e);
    expect(g).not.toBeNull();
    expect(isColumnGroup(g!.node)).toBe(true);
    expect(changeColumnCount(e, 1)).toBe(true);
    expect(md(e).match(/\n---\n/g)?.length).toBe(2);
    e.destroy();
  });

  it("选中一栏时也够得到组（手柄的目标就是栏）", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    selectColumn(e, 0, 1);
    expect(isColumnGroup(findColumnGroup(e)!.node)).toBe(true);
    expect(selectColumnGroup(e)).toBe(true);
    expect(isColumnGroup(getSelectedBlock(e)!.node)).toBe(true);
    e.destroy();
  });

  it("不在任何分栏组里时 findColumnGroup 给 null、「整组」拒绝", () => {
    const e = makeEditor("甲");
    e.commands.setTextSelection(1);
    expect(findColumnGroup(e)).toBeNull();
    expect(selectColumnGroup(e)).toBe(false);
    e.destroy();
  });

  it("非分栏组上调用分栏操作一律拒绝", () => {
    const e = makeEditor("甲");
    selectTopBlock(e, 0);
    expect(changeColumnCount(e, 1)).toBe(false);
    expect(equalizeColumns(e)).toBe(false);
    e.destroy();
  });
});

describe("高亮块配色（#525 颜色一半）", () => {
  const md = (editor: Editor) => (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();

  it("整块选中：改色只改首行 marker，正文原样", () => {
    const editor = makeEditor("> [!💡]\n> 需要强调");
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    expect(findCallout(editor)?.pos).toBe(0);
    expect(setCalloutColor(editor, "#dbeafe")).toBe(true);
    expect(md(editor)).toBe("> [!💡 bg=#dbeafe]\n> 需要强调");
    editor.destroy();
  });

  it("光标在高亮块里的段落上：沿祖先找到它，回默认色时 marker 不写 bg=", () => {
    const editor = makeEditor("> [!📌 bg=#fee2e2]\n> 第一行");
    editor.commands.setTextSelection(4);
    expect(findCallout(editor)?.node.attrs.color).toBe("#fee2e2");
    expect(setCalloutColor(editor, null)).toBe(true);
    expect(md(editor)).toBe("> [!📌]\n> 第一行");
    editor.destroy();
  });

  it("不在高亮块里：找不到、不改任何东西", () => {
    const editor = makeEditor("普通段落\n\n> 只是引用");
    editor.commands.setTextSelection(3);
    expect(findCallout(editor)).toBeNull();
    expect(setCalloutColor(editor, "#dbeafe")).toBe(false);
    expect(md(editor)).toBe("普通段落\n\n> 只是引用");
    editor.destroy();
  });
});

describe("高亮块图标（#525 图标一半）", () => {
  const md = (editor: Editor) => (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();

  it("按 pos 改：只动 marker 主参数位，bg= 与正文原样", () => {
    const editor = makeEditor("> [!💡 bg=#dbeafe]\n> 需要强调");
    expect(setCalloutEmoji(editor, "🔥", 0)).toBe(true);
    expect(md(editor)).toBe("> [!🔥 bg=#dbeafe]\n> 需要强调");
    editor.destroy();
  });

  it("无图标：空串落成 `[!]`，再解析回来 emoji 仍是空（不回落默认 💡）", () => {
    const editor = makeEditor("> [!📌]\n> 第一行");
    expect(setCalloutEmoji(editor, "", 0)).toBe(true);
    const out = md(editor);
    expect(out).toBe("> [!]\n> 第一行");
    const again = makeEditor(out);
    expect(again.state.doc.firstChild?.attrs.emoji).toBe("");
    expect(md(again)).toBe(out);
    again.destroy();
    editor.destroy();
  });

  it("不给 pos 走当前选区：光标在高亮块段落里也能改", () => {
    const editor = makeEditor("> [!📌]\n> 第一行");
    editor.commands.setTextSelection(4);
    expect(setCalloutEmoji(editor, " 🎭 ")).toBe(true);
    expect(md(editor)).toBe("> [!🎭]\n> 第一行");
    editor.destroy();
  });

  it("pos 不是高亮块：不改、返回 false", () => {
    const editor = makeEditor("普通段落\n\n> [!💡]\n> 高亮");
    expect(setCalloutEmoji(editor, "🔥", 0)).toBe(false);
    expect(md(editor)).toBe("普通段落\n\n> [!💡]\n> 高亮");
    editor.destroy();
  });
});
