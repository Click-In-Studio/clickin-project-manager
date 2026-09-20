// @vitest-environment jsdom
// 协作远端光标的块坐标（#517）：两端过一次有损 markdown 后块序号必须仍能对齐。
//
// 断言的不是「序号算成几」，而是**发送端光标所在的文字，接收端解析出的位置也在
// 同一段文字里**——中间真的走一遍 getMarkdown → 重新解析，和线上 update 帧同款。
import { describe, it, expect } from "vitest";
import { Editor, type Content, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Markdown } from "tiptap-markdown";
import { Callout } from "@/lib/editor/tiptap-callout";
import { Column, ColumnGroup } from "@/lib/editor/tiptap-columns";
import { vanishesInMarkdown, projectBlockIndex, resolveRemoteCursorPos } from "@/lib/editor/remote-cursor";

function makeEditor(content: Content) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ transformCopiedText: true, breaks: true }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList, TaskItem.configure({ nested: true }),
      Callout, Column, ColumnGroup,
    ],
    content,
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toMarkdown = (e: Editor): string => (e.storage as any).markdown.getMarkdown();
const T = (text: string) => ({ type: "text", text });
const P = (text?: string) => (text == null ? { type: "paragraph" } : { type: "paragraph", content: [T(text)] });
const doc = (...blocks: JSONContent[]): JSONContent => ({ type: "doc", content: blocks });

/** 发送端：光标放到第 localIndex 块内偏移 offset 处，按线上 onSelectionUpdate 同款算法出坐标 */
function senderCursor(e: Editor, localIndex: number, offset: number) {
  let pos = 0;
  for (let i = 0; i < localIndex; i++) pos += e.state.doc.child(i).nodeSize;
  const $head = e.state.doc.resolve(pos + 1 + offset);
  return { blockIndex: projectBlockIndex(e.state.doc, $head.index(0)), offset: Math.max(0, $head.pos - $head.start(1)) };
}

/** 接收端：解析发送端的 markdown，把远端坐标落成位置，回报所在顶层块的文字与块内偏移 */
function receiverLanding(md: string, cursor: { blockIndex: number; offset: number }) {
  const r = makeEditor(md);
  const pos = resolveRemoteCursorPos(r.state.doc, cursor);
  const $pos = r.state.doc.resolve(pos);
  return { text: $pos.node(1).textContent, offset: pos - $pos.start(1), childCount: r.state.doc.childCount };
}

describe("vanishesInMarkdown", () => {
  it("只有空白/软换行段落会消失；空标题、空代码块、空引用、空列表、分割线都有 markdown 形态", () => {
    const e = makeEditor(doc(
      P(), P("  "), { type: "paragraph", content: [{ type: "hardBreak" }] },
      { type: "heading", attrs: { level: 2 } }, { type: "codeBlock" },
      { type: "blockquote", content: [P()] }, { type: "horizontalRule" },
      { type: "orderedList", content: [{ type: "listItem", content: [P()] }] },
      P("正文"),
    ));
    const flags = e.state.doc.content.content.map(vanishesInMarkdown);
    expect(flags).toEqual([true, true, true, false, false, false, false, false, false]);
    // 判据与真实序列化一致：消失的块在往返后不存在
    const back = makeEditor(toMarkdown(e));
    expect(back.state.doc.childCount).toBe(flags.filter(v => !v).length);
  });
});

describe("发送端投影 → markdown 往返 → 接收端落点", () => {
  it("光标前有空行：本地第 4 块在对方那里是第 2 块，落到同一段文字", () => {
    const s = makeEditor(doc(P("a"), P(), P(), P("bcd")));
    const cursor = senderCursor(s, 3, 2);
    expect(cursor).toEqual({ blockIndex: 1, offset: 2 });
    const landed = receiverLanding(toMarkdown(s), cursor);
    expect(landed.childCount).toBe(2); // 空行确实丢了
    expect(landed).toMatchObject({ text: "bcd", offset: 2 });
  });

  it("文末回车停在空行：对方没有这一块，钳到末段尾而不是消失", () => {
    const s = makeEditor(doc(P("abc"), P()));
    const cursor = senderCursor(s, 1, 0);
    expect(cursor).toEqual({ blockIndex: 1, offset: 0 });
    expect(receiverLanding(toMarkdown(s), cursor)).toMatchObject({ text: "abc", offset: 3, childCount: 1 });
  });

  it("光标停在两段之间的空行：落到下一段开头", () => {
    const s = makeEditor(doc(P("a"), P(), P("b")));
    expect(receiverLanding(toMarkdown(s), senderCursor(s, 1, 0))).toMatchObject({ text: "b", offset: 0 });
  });

  it("接收端自己也在敲空行：本地空行同样跳过，仍落到同一段", () => {
    const s = makeEditor(doc(P("a"), P("b")));
    const cursor = senderCursor(s, 1, 1);
    const r = makeEditor(doc(P("a"), P(), P(), P("b"), P()));
    const pos = resolveRemoteCursorPos(r.state.doc, cursor);
    const $pos = r.state.doc.resolve(pos);
    expect($pos.node(1).textContent).toBe("b");
    expect(pos - $pos.start(1)).toBe(1);
  });

  it("空标题/空列表这类有形态的块不影响序号", () => {
    const s = makeEditor(doc(P("a"), { type: "heading", attrs: { level: 2 } }, P(), P("b")));
    expect(receiverLanding(toMarkdown(s), senderCursor(s, 3, 1))).toMatchObject({ text: "b", offset: 1 });
  });

  it("列表内光标：偏移跨嵌套展平，对方落在同一项文字里", () => {
    const li = (t: string) => ({ type: "listItem", content: [P(t)] });
    const s = makeEditor(doc(P("a"), P(), { type: "bulletList", content: [li("one"), li("two")] }));
    // 第二项 "two" 内偏移 1：listItem(1) + paragraph(1) + "one"(3) + close(2) + listItem(1) + paragraph(1) + 1
    const cursor = senderCursor(s, 2, 1 + 1 + 3 + 2 + 1 + 1 + 1);
    expect(cursor.blockIndex).toBe(1);
    const r = makeEditor(toMarkdown(s));
    const pos = resolveRemoteCursorPos(r.state.doc, cursor);
    const $pos = r.state.doc.resolve(pos);
    expect($pos.node(1).type.name).toBe("bulletList");
    expect($pos.parent.textContent).toBe("two");
    expect($pos.parentOffset).toBe(1);
  });
});

describe("resolveRemoteCursorPos 兜底", () => {
  it("偏移超出块尺寸钳到块尾", () => {
    const r = makeEditor(doc(P("ab"), P("cd")));
    const pos = resolveRemoteCursorPos(r.state.doc, { blockIndex: 0, offset: 99 });
    expect(r.state.doc.resolve(pos).parentOffset).toBe(2);
  });
  it("序号远超块数钳到最后一个有形态的块尾（末尾空行不算）", () => {
    const r = makeEditor(doc(P("ab"), P("cd"), P()));
    const pos = resolveRemoteCursorPos(r.state.doc, { blockIndex: 7, offset: 0 });
    const $pos = r.state.doc.resolve(pos);
    expect($pos.parent.textContent).toBe("cd");
    expect($pos.parentOffset).toBe(2);
  });
  it("整篇都是空行也能落到一个合法位置", () => {
    const r = makeEditor(doc(P(), P()));
    const pos = resolveRemoteCursorPos(r.state.doc, { blockIndex: 0, offset: 0 });
    expect(() => r.state.doc.resolve(pos)).not.toThrow();
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThanOrEqual(r.state.doc.content.size);
  });
});
