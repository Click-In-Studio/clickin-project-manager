// @vitest-environment jsdom
// 块手柄的命中规则。
//
// 这里**忠实复刻官方 DragHandle 的候选枚举**（extension-drag-handle 里
// `$pos = doc.resolve(光标位置)`，候选 = `$pos.node(depth)`，depth 从
// `$pos.depth` 递减到 1），因为这条规则踩过的坑正藏在这个细节里：
// `$pos.node(d)` 在 `d === depth` 时给的是**候选自己**，把它当祖先一起判，
// table 和 column 就会自我排除——整张表、整栏的手柄凭空消失，而单看规则
// 代码完全看不出问题。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { Column, ColumnGroup } from "@/lib/tiptap-columns";
import { scoreDragTarget } from "@/lib/editor-drag-unit";

function makeEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ transformCopiedText: true, breaks: true }),
      TableKit.configure({ table: { resizable: false } }),
      Column, ColumnGroup,
    ],
    content,
  });
}

/**
 * 把光标放在 cursorPos，按官方那套枚举候选并打分，返回**未被排除**的节点名。
 * 官方随后在这些里面挑分最高的作为手柄目标。
 */
function allowedTargets(editor: Editor, cursorPos: number): string[] {
  const $pos = editor.state.doc.resolve(cursorPos);
  const out: string[] = [];
  for (let depth = $pos.depth; depth >= 1; depth--) {
    const node = $pos.node(depth);
    if (scoreDragTarget({ node, depth, $pos }) < 1000) out.push(node.type.name);
  }
  return out;
}

/** 第一个该类型节点内部的一个位置 */
function insideFirst(editor: Editor, typeName: string): number {
  let pos = -1;
  editor.state.doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === typeName) { pos = p; return false; }
  });
  if (pos < 0) throw new Error(`no ${typeName}`);
  return pos + 1;
}

describe("普通正文", () => {
  it("顶层段落自己就是目标", () => {
    const e = makeEditor("甲");
    expect(allowedTargets(e, 1)).toEqual(["paragraph"]);
    e.destroy();
  });

  it("列表项内部：段落与列表项都可选（Notion 同款，列表每条都能拖）", () => {
    const e = makeEditor("- 甲\n- 乙");
    const targets = allowedTargets(e, insideFirst(e, "paragraph"));
    expect(targets).toContain("paragraph");
    expect(targets).toContain("listItem");
    e.destroy();
  });
});

describe("表格：唯一目标是整张表", () => {
  const T = "| a | b |\n| --- | --- |\n| 1 | 2 |";

  // 这条就是"表格 handle 消失"的回归测试
  it("整张表必须仍是目标（别把自己当祖先排除掉）", () => {
    const e = makeEditor(T);
    expect(allowedTargets(e, insideFirst(e, "paragraph"))).toEqual(["table"]);
    e.destroy();
  });

  it("单元格里的段落、表格行、单元格一律不给手柄", () => {
    const e = makeEditor(T);
    const targets = allowedTargets(e, insideFirst(e, "paragraph"));
    for (const n of ["paragraph", "tableRow", "tableCell", "tableHeader"]) {
      expect(targets).not.toContain(n);
    }
    e.destroy();
  });
});

describe("分栏：唯一目标是栏", () => {
  const C = ":::cols\n\n左\n\n---\n\n右\n\n:::";

  it("栏必须仍是目标", () => {
    const e = makeEditor(C);
    expect(allowedTargets(e, insideFirst(e, "paragraph"))).toEqual(["column"]);
    e.destroy();
  });

  it("栏里的块不给手柄，分栏组自己也不给", () => {
    const e = makeEditor(C);
    const targets = allowedTargets(e, insideFirst(e, "paragraph"));
    expect(targets).not.toContain("paragraph");
    expect(targets).not.toContain("columnGroup");
    e.destroy();
  });
});

describe("嵌套容器", () => {
  it("栏里的表格不给手柄 —— 栏内的单位仍是栏", () => {
    const e = makeEditor(":::cols\n\n| a |\n| --- |\n| 1 |\n\n---\n\n右\n\n:::");
    const targets = allowedTargets(e, insideFirst(e, "tableCell") + 1);
    expect(targets).toEqual(["column"]);
    expect(targets).not.toContain("table");
    e.destroy();
  });
});

describe("反证 —— 从 $pos.depth 起步会怎样", () => {
  // 证明上面那些断言不是恒真的：把起点从 depth-1 换成 $pos.depth（即错误写法），
  // table / column 就会自我排除。没有这条，规则被改回错误写法也照样绿
  function buggyScore(node: { type: { name: string } }, $pos: { depth: number; node: (d: number) => { type: { name: string } } }): number {
    if (node.type.name === "columnGroup") return 1000;
    for (let d = $pos.depth; d >= 1; d--) {
      if (["column", "table"].includes($pos.node(d).type.name)) return 1000;
    }
    return 0;
  }

  it("错误写法下整张表被自己排除（这正是当时的症状）", () => {
    const e = makeEditor("| a | b |\n| --- | --- |\n| 1 | 2 |");
    const $pos = e.state.doc.resolve(insideFirst(e, "paragraph"));
    const table = $pos.node(1);
    expect(table.type.name).toBe("table");
    expect(buggyScore(table, $pos)).toBe(1000);          // 错误写法：排除
    expect(scoreDragTarget({ node: table, depth: 1, $pos })).toBe(0); // 正确写法：保留
    e.destroy();
  });
});
