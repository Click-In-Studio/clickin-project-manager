// @vitest-environment jsdom
// 拖拽造栏的文档手术测试。
//
// 几何判定（哪里算"边缘"）吃 DOM 矩形，jsdom 没有布局，测不了；但**落地成
// 什么文档**是纯函数，而这恰好是会悄悄改坏结构的那一半。所以这里全部断言
// 序列化后的 markdown——分栏是方言，结构错了就是 fence 错了。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Callout } from "@/lib/tiptap-callout";
import { Column, ColumnGroup } from "@/lib/tiptap-columns";
import {
  buildColumnDropTransaction, buildColumnUnwrapTransaction, ColumnDrop,
  type ColumnDropTarget,
} from "@/lib/tiptap-column-drop";
import { ColumnEditing } from "@/lib/tiptap-column-editing";

function makeEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ transformCopiedText: true, breaks: true }),
      Callout, Column, ColumnGroup, ColumnEditing,
    ],
    content,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const md = (e: Editor) => (e.storage as any).markdown.getMarkdown() as string;

const LINE = { x: 0, top: 0, bottom: 10 }; // 几何只影响画线，不影响文档手术

/** 第 index 个顶层块的 [from, to) */
function topBlockRange(editor: Editor, index: number) {
  let from = 0;
  for (let i = 0; i < index; i++) from += editor.state.doc.child(i).nodeSize;
  return { from, to: from + editor.state.doc.child(index).nodeSize };
}

/** 把第 srcIndex 个顶层块拖到 target，并 dispatch */
function drop(editor: Editor, srcIndex: number, target: ColumnDropTarget) {
  const src = topBlockRange(editor, srcIndex);
  const dragged = editor.state.doc.child(srcIndex);
  const tr = buildColumnDropTransaction(editor.state, target, dragged, src);
  if (tr) editor.view.dispatch(tr);
  return tr;
}

describe("拖到普通块的边缘 → 就地包成两栏", () => {
  it("拖到右边缘：目标在左，拖来的在右", () => {
    const e = makeEditor("甲\n\n乙");
    const t = topBlockRange(e, 1);
    const tr = drop(e, 0, { kind: "wrap", blockFrom: t.from, blockTo: t.to, side: "right", line: LINE });
    expect(tr).not.toBeNull();
    const out = md(e);
    expect(out.startsWith(":::cols")).toBe(true);
    const [left, right] = out.split("\n---\n");
    expect(left).toContain("乙");
    expect(right).toContain("甲");
    e.destroy();
  });

  it("拖到左边缘：拖来的在左，目标在右", () => {
    const e = makeEditor("甲\n\n乙");
    const t = topBlockRange(e, 1);
    drop(e, 0, { kind: "wrap", blockFrom: t.from, blockTo: t.to, side: "left", line: LINE });
    const [left, right] = md(e).split("\n---\n");
    expect(left).toContain("甲");
    expect(right).toContain("乙");
    e.destroy();
  });

  it("源块从原位置消失（是移动不是复制）", () => {
    const e = makeEditor("甲\n\n乙\n\n丙");
    const t = topBlockRange(e, 1);
    drop(e, 0, { kind: "wrap", blockFrom: t.from, blockTo: t.to, side: "right", line: LINE });
    const out = md(e);
    expect(out.match(/甲/g)?.length).toBe(1); // 只剩栏里那一份
    expect(out).toContain("丙");
    e.destroy();
  });

  it("造出来的分栏不写宽度主参数位（canonical 均分形态）", () => {
    const e = makeEditor("甲\n\n乙");
    const t = topBlockRange(e, 1);
    drop(e, 0, { kind: "wrap", blockFrom: t.from, blockTo: t.to, side: "right", line: LINE });
    expect(md(e)).not.toMatch(/:::cols\s+\d/);
    e.destroy();
  });

  it("落地形态可逐字往返（保真锁纪律）", () => {
    const e = makeEditor("甲\n\n乙");
    const t = topBlockRange(e, 1);
    drop(e, 0, { kind: "wrap", blockFrom: t.from, blockTo: t.to, side: "right", line: LINE });
    const produced = md(e);
    e.destroy();
    const again = makeEditor(produced);
    expect(md(again)).toBe(produced);
    again.destroy();
  });

  it("标题、引用这些带方言的块也能被拖进栏且形态不变", () => {
    const e = makeEditor("## 标题\n\n乙");
    const t = topBlockRange(e, 1);
    drop(e, 0, { kind: "wrap", blockFrom: t.from, blockTo: t.to, side: "right", line: LINE });
    expect(md(e)).toContain("## 标题");
    e.destroy();
  });
});

describe("拖到已有分栏组 → 插一栏（N 栏，不是只支持两栏）", () => {
  const TWO_COLS = ":::cols\n\n左\n\n---\n\n右\n\n:::";

  it("插到最前 → 三栏，新栏在第一位", () => {
    const e = makeEditor(`甲\n\n${TWO_COLS}`);
    const g = topBlockRange(e, 1);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: g.from, groupTo: g.to, index: 0, line: LINE },
      e.state.doc.child(0),
      topBlockRange(e, 0),
    );
    expect(tr).not.toBeNull();
    e.view.dispatch(tr!);
    const parts = md(e).split("\n---\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("甲");
    expect(parts[1]).toContain("左");
    expect(parts[2]).toContain("右");
    e.destroy();
  });

  it("插到两栏之间 → 三栏，新栏在中间", () => {
    const e = makeEditor(`甲\n\n${TWO_COLS}`);
    const g = topBlockRange(e, 1);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: g.from, groupTo: g.to, index: 1, line: LINE },
      e.state.doc.child(0),
      topBlockRange(e, 0),
    );
    e.view.dispatch(tr!);
    const parts = md(e).split("\n---\n");
    expect(parts).toHaveLength(3);
    expect(parts[1]).toContain("甲");
    e.destroy();
  });

  it("三栏还能再插成四栏 —— 栏数没有上限", () => {
    const e = makeEditor(`甲\n\n:::cols\n\n一\n\n---\n\n二\n\n---\n\n三\n\n:::`);
    const g = topBlockRange(e, 1);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: g.from, groupTo: g.to, index: 3, line: LINE },
      e.state.doc.child(0),
      topBlockRange(e, 0),
    );
    e.view.dispatch(tr!);
    const parts = md(e).split("\n---\n");
    expect(parts).toHaveLength(4);
    expect(parts[3]).toContain("甲");
    e.destroy();
  });

  it("插栏后清空 ratio —— 旧宽度串是按旧栏数配的", () => {
    const e = makeEditor("甲\n\n:::cols 40,60\n\n左\n\n---\n\n右\n\n:::");
    expect(md(e)).toContain(":::cols 40,60"); // 前提：宽度确实解析进来了
    const g = topBlockRange(e, 1);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: g.from, groupTo: g.to, index: 2, line: LINE },
      e.state.doc.child(0),
      topBlockRange(e, 0),
    );
    e.view.dispatch(tr!);
    expect(md(e)).not.toMatch(/:::cols\s+\d/);
    e.destroy();
  });

  it("index 越界被夹住，不产生坏结构", () => {
    const e = makeEditor(`甲\n\n${TWO_COLS}`);
    const g = topBlockRange(e, 1);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: g.from, groupTo: g.to, index: 99, line: LINE },
      e.state.doc.child(0),
      topBlockRange(e, 0),
    );
    e.view.dispatch(tr!);
    expect(md(e).split("\n---\n")).toHaveLength(3);
    e.destroy();
  });

  it("插栏结果可逐字往返", () => {
    const e = makeEditor(`甲\n\n${TWO_COLS}`);
    const g = topBlockRange(e, 1);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: g.from, groupTo: g.to, index: 1, line: LINE },
      e.state.doc.child(0),
      topBlockRange(e, 0),
    );
    e.view.dispatch(tr!);
    const produced = md(e);
    e.destroy();
    const again = makeEditor(produced);
    expect(md(again)).toBe(produced);
    again.destroy();
  });

  it("组内的块拖到本组另一处 —— 组仍成立且不丢内容", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    // 取第一栏里那个段落
    const groupPos = 0;
    const group = e.state.doc.child(0);
    const firstCol = group.child(0);
    const paraFrom = groupPos + 1 + 1; // group 开标签 + column 开标签
    const paraTo = paraFrom + firstCol.child(0).nodeSize;
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: groupPos, groupTo: groupPos + group.nodeSize, index: 2, line: LINE },
      firstCol.child(0),
      { from: paraFrom, to: paraTo },
    );
    if (tr) e.view.dispatch(tr);
    const out = md(e);
    expect(out).toContain("左");
    expect(out).toContain("右");
    expect(out.startsWith(":::cols")).toBe(true);
    e.destroy();
  });
});

describe("拖走一整栏 —— 语义是「这一整栏被移走」", () => {
  /** 组里第 index 栏的位置区间 */
  function columnRange(editor: Editor, groupPos: number, index: number) {
    const group = editor.state.doc.nodeAt(groupPos)!;
    let from = groupPos + 1;
    for (let i = 0; i < index; i++) from += group.child(i).nodeSize;
    return { from, to: from + group.child(index).nodeSize, node: group.child(index) };
  }

  it("拖到普通位置：栏就地摊平成普通块，源组因剩一栏被拆掉", () => {
    const e = makeEditor("甲\n\n:::cols\n\n左\n\n---\n\n右\n\n:::");
    const groupPos = e.state.doc.child(0).nodeSize;
    const col = columnRange(e, groupPos, 0);
    const tr = buildColumnUnwrapTransaction(e.state, 0, col.node, { from: col.from, to: col.to });
    expect(tr).not.toBeNull();
    e.view.dispatch(tr!);
    // 左被整栏移到最前；组只剩一栏 → 拆组，右回到普通块
    expect(md(e)).toBe("左\n\n甲\n\n右");
    e.destroy();
  });

  it("三栏里拖走一栏：组还在，只是少一栏", () => {
    const e = makeEditor("甲\n\n:::cols\n\n一\n\n---\n\n二\n\n---\n\n三\n\n:::");
    const groupPos = e.state.doc.child(0).nodeSize;
    const col = columnRange(e, groupPos, 1);
    const tr = buildColumnUnwrapTransaction(e.state, 0, col.node, { from: col.from, to: col.to });
    e.view.dispatch(tr!);
    const out = md(e);
    expect(out.startsWith("二")).toBe(true);
    expect(out).toContain(":::cols");
    expect(out.match(/\n---\n/g)?.length).toBe(1);
    e.destroy();
  });

  it("整栏拖到另一处栏边缘：栏被移过去，不会被再包一层（栏套栏）", () => {
    const e = makeEditor(":::cols\n\n一\n\n---\n\n二\n\n---\n\n三\n\n:::");
    const col = columnRange(e, 0, 2);
    const group = e.state.doc.child(0);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: 0, groupTo: group.nodeSize, index: 0, line: LINE },
      col.node,
      { from: col.from, to: col.to },
    );
    expect(tr).not.toBeNull();
    e.view.dispatch(tr!);
    const parts = md(e).split("\n---\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("三"); // 被移到最前
    // 没有嵌套的 :::cols
    expect(md(e).match(/:::cols/g)?.length).toBe(1);
    e.destroy();
  });

  it("栏拖到自己身上不动", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    const col = columnRange(e, 0, 0);
    const tr = buildColumnUnwrapTransaction(e.state, col.from + 1, col.node, { from: col.from, to: col.to });
    expect(tr).toBeNull();
    e.destroy();
  });
});

describe("栏里没有块级落点", () => {
  it("forbidden 落点不生成任何事务（调用侧据此把这次拖放整个吞掉）", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "forbidden" },
      e.state.schema.nodes.paragraph.create(null, e.state.schema.text("新")),
      null,
    );
    expect(tr).toBeNull();
    e.destroy();
  });
});

describe("栏不能嵌套", () => {
  it("嵌套的分栏组会被就地拆平（粘贴 / AI 写入的兜底）", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    const schema = e.state.schema;
    // 手工往第一栏里塞一个分栏组——模拟粘贴进来的嵌套结构
    const inner = schema.nodes.columnGroup.create(null, [
      schema.nodes.column.create(null, schema.nodes.paragraph.create(null, schema.text("内一"))),
      schema.nodes.column.create(null, schema.nodes.paragraph.create(null, schema.text("内二"))),
    ]);
    e.view.dispatch(e.state.tr.insert(2, inner));
    // appendTransaction 应该已经把它拆平了
    expect(md(e).match(/:::cols/g)?.length).toBe(1);
    expect(md(e)).toContain("内一");
    expect(md(e)).toContain("内二");
    e.destroy();
  });

  it("落地形态仍可逐字往返（嵌套 fence 会让解析侧放弃整组）", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    const schema = e.state.schema;
    e.view.dispatch(e.state.tr.insert(2, schema.nodes.columnGroup.create(null, [
      schema.nodes.column.create(null, schema.nodes.paragraph.create(null, schema.text("内一"))),
      schema.nodes.column.create(null, schema.nodes.paragraph.create(null, schema.text("内二"))),
    ])));
    const produced = md(e);
    e.destroy();
    const again = makeEditor(produced);
    expect(md(again)).toBe(produced);
    again.destroy();
  });
});

describe("与内建 dropcursor 的让位约定", () => {
  it("disableDropCursor 被挂到每一个节点 spec 上", () => {
    const e = new Editor({
      extensions: [StarterKit, Markdown, Callout, Column, ColumnGroup, ColumnDrop],
      content: "甲",
    });
    // prosemirror-dropcursor 读的是**光标所在节点**的 spec，所以挂漏一个节点
    // 类型，在那种块上就会横线竖线同时出现。这条坏了不报错，只是"看着怪"
    for (const name of ["paragraph", "heading", "blockquote", "columnGroup", "column"]) {
      expect(typeof e.schema.nodes[name].spec.disableDropCursor).toBe("function");
    }
    e.destroy();
  });

  it("不装 ColumnDrop 时节点 spec 上没有这个字段（反证：确实是它挂的）", () => {
    const e = new Editor({ extensions: [StarterKit, Column, ColumnGroup], content: "甲" });
    expect(e.schema.nodes.paragraph.spec.disableDropCursor).toBeUndefined();
    e.destroy();
  });
});

describe("拒绝接管的情形（返回 null，调用侧回退默认拖放）", () => {
  it("拖的是分栏组本身 —— 嵌套 :::cols 会让解析侧放弃整组，内容掉出分栏", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::\n\n乙");
    const t = topBlockRange(e, 1);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "wrap", blockFrom: t.from, blockTo: t.to, side: "right", line: LINE },
      e.state.doc.child(0), // 分栏组
      topBlockRange(e, 0),
    );
    expect(tr).toBeNull();
    e.destroy();
  });

  it("落点就是被拖的块自己", () => {
    const e = makeEditor("甲\n\n乙");
    const src = topBlockRange(e, 0);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "wrap", blockFrom: src.from, blockTo: src.to, side: "right", line: LINE },
      e.state.doc.child(0),
      src,
    );
    expect(tr).toBeNull();
    e.destroy();
  });

  it("wrap 的目标已经是分栏组 —— 该走 insert 分支", () => {
    const e = makeEditor("甲\n\n:::cols\n\n左\n\n---\n\n右\n\n:::");
    const t = topBlockRange(e, 1);
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "wrap", blockFrom: t.from, blockTo: t.to, side: "right", line: LINE },
      e.state.doc.child(0),
      topBlockRange(e, 0),
    );
    expect(tr).toBeNull();
    e.destroy();
  });

  it("坐标对不上真实节点（并发改文档后的陈旧落点）不硬写", () => {
    const e = makeEditor("甲\n\n乙");
    const tr = buildColumnDropTransaction(
      e.state,
      { kind: "insert", groupFrom: 0, groupTo: 3, index: 0, line: LINE },
      e.state.doc.child(0),
      null,
    );
    expect(tr).toBeNull(); // 0..3 处不是分栏组
    e.destroy();
  });
});
