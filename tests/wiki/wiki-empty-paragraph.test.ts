// @vitest-environment jsdom
// 空段落方言（#576）：编辑器里的空行序列化成独占一行的 `&nbsp;`，解析时还原成空段落。
//
// 用真实扩展集往返（保真锁纪律：解析→再序列化必须逐字复原），断的是 issue 里那张
// 往返实测表——相邻同类列表之间的空行没了，CommonMark 就把两个列表并成一个。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Editor, type Content, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { Callout } from "@/lib/editor/tiptap-callout";
import { MarkdownParagraph, EMPTY_PARAGRAPH_MD, isVisuallyEmptyParagraph, restoreEmptyParagraphs } from "@/lib/editor/tiptap-empty-paragraph";
import { checkFidelity } from "@/lib/wiki/fidelity";

function makeEditor(content: Content) {
  return new Editor({
    extensions: [
      StarterKit.configure({ paragraph: false }), MarkdownParagraph,
      Markdown.configure({ transformCopiedText: true, breaks: true }),
      TableKit.configure({ table: { resizable: false } }),
      Callout,
    ],
    content,
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toMarkdown = (e: Editor): string => (e.storage as any).markdown.getMarkdown();
const T = (text: string) => ({ type: "text", text });
const P = (text?: string) => (text == null ? { type: "paragraph" } : { type: "paragraph", content: [T(text)] });
const li = (...blocks: JSONContent[]) => ({ type: "listItem", content: blocks });
const ol = (...items: string[]) => ({ type: "orderedList", content: items.map(t => li(P(t))) });
const bl = (...items: string[]) => ({ type: "bulletList", content: items.map(t => li(P(t))) });
const doc = (...blocks: JSONContent[]): JSONContent => ({ type: "doc", content: blocks });

/** 顶层块形态摘要：类型 + 列表项数 */
function shape(e: Editor): string[] {
  const out: string[] = [];
  e.state.doc.forEach(n => out.push(n.type.name + (n.type.name.endsWith("List") ? `(${n.childCount})` : "")));
  return out;
}

/** 发送端文档 → markdown → 接收端文档 → markdown：形态一致且幂等 */
function roundtrip(content: JSONContent) {
  const sender = makeEditor(content);
  const md = toMarkdown(sender);
  const receiver = makeEditor(md);
  return { md, senderShape: shape(sender), receiverShape: shape(receiver), md2: toMarkdown(receiver) };
}

describe("相邻同类列表之间的空行（issue 往返实测表）", () => {
  it("OL | 空段 | OL：不再并成一个四项列表", () => {
    const r = roundtrip(doc(ol("xxx", "yyy"), P(), ol("ppp", "qqq")));
    expect(r.md).toBe(`1. xxx\n2. yyy\n\n${EMPTY_PARAGRAPH_MD}\n\n1. ppp\n2. qqq`);
    expect(r.receiverShape).toEqual(["orderedList(2)", "paragraph", "orderedList(2)"]);
    expect(r.md2).toBe(r.md);
  });

  it("BL | 空段 | BL 同款", () => {
    const r = roundtrip(doc(bl("xxx", "yyy"), P(), bl("ppp", "qqq")));
    expect(r.receiverShape).toEqual(["bulletList(2)", "paragraph", "bulletList(2)"]);
    expect(r.md2).toBe(r.md);
  });

  it("并起来的列表不会变 loose（项与项之间不再空一行）", () => {
    const r = roundtrip(doc(ol("xxx", "yyy"), P(), ol("ppp", "qqq")));
    expect(r.md).not.toContain("1. xxx\n\n2.");
  });

  it("反证：没有方言时同一份文档确实被并成一个列表", () => {
    const plain = new Editor({ extensions: [StarterKit, Markdown.configure({ breaks: true })], content: doc(ol("xxx", "yyy"), P(), ol("ppp", "qqq")) });
    const md = toMarkdown(plain);
    expect(md).not.toContain(EMPTY_PARAGRAPH_MD);
    const back = new Editor({ extensions: [StarterKit, Markdown.configure({ breaks: true })], content: md });
    expect(shape(back)).toEqual(["orderedList(4)"]);
  });
});

describe("空段落在各种位置", () => {
  it("段落之间 / 文末回车留下的空行都保留，块数两端一致", () => {
    for (const d of [doc(P("a"), P(), P("b")), doc(P("a"), P()), doc(P(), P("a")), doc(P(), P())]) {
      const r = roundtrip(d);
      expect(r.receiverShape).toEqual(r.senderShape);
      expect(r.md2).toBe(r.md);
    }
  });

  it("空白文本 / 只有软换行的段落按空段落处理", () => {
    const r = roundtrip(doc(P("a"), P("   "), { type: "paragraph", content: [{ type: "hardBreak" }] }, P("b")));
    expect(r.md).toBe(`a\n\n${EMPTY_PARAGRAPH_MD}\n\n${EMPTY_PARAGRAPH_MD}\n\nb`);
    expect(r.receiverShape).toHaveLength(4);
  });

  it("空文档仍是空串——独生子由父块撑着位置", () => {
    expect(roundtrip(doc(P())).md).toBe("");
    expect(roundtrip(doc({ type: "bulletList", content: [li(P())] })).md).toBe("- ");
    expect(roundtrip(doc({ type: "blockquote", content: [P()] })).md).not.toContain(EMPTY_PARAGRAPH_MD);
  });

  it("列表项 / 引用块 / callout 内的第二个空段照样写", () => {
    const inList = roundtrip(doc({ type: "bulletList", content: [li(P("a"), P())] }));
    expect(inList.md).toBe(`- a\n\n  ${EMPTY_PARAGRAPH_MD}`);
    expect(inList.md2).toBe(inList.md);
    const inQuote = roundtrip(doc({ type: "blockquote", content: [P("a"), P(), P("b")] }));
    expect(inQuote.md2).toBe(inQuote.md);
    const inCallout = roundtrip(doc({ type: "callout", attrs: { emoji: "💡" }, content: [P("a"), P(), P("b")] }));
    expect(inCallout.md).toBe(`> [!💡]\n> a\n>\n> ${EMPTY_PARAGRAPH_MD}\n>\n> b`);
    expect(inCallout.md2).toBe(inCallout.md);
  });

  it("表格空单元格不写 `&nbsp;`——由 `|` 撑着", () => {
    const md = "| a |  |\n| --- | --- |\n| 1 |  |\n";
    const e = makeEditor(md);
    expect(toMarkdown(e)).toBe(md);
  });
});

describe("解析侧", () => {
  it("用户手写的 `&nbsp;` 行进编辑器就是空段落，往返逐字复原", () => {
    const md = "甲\n\n&nbsp;\n\n乙";
    const e = makeEditor(md);
    expect(shape(e)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(e.state.doc.child(1).textContent).toBe("");
    expect(toMarkdown(e)).toBe(md);
  });

  it("正文里夹着的 nbsp 不动——那是用户自己写的", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>\u00a0</p><p>甲\u00a0乙</p><p>\u00a0<b>x</b></p>";
    restoreEmptyParagraphs(root);
    expect(root.innerHTML).toBe("<p></p><p>甲&nbsp;乙</p><p>&nbsp;<b>x</b></p>");
  });

  it("isVisuallyEmptyParagraph：图片/mention 等原子节点不算空", () => {
    const e = makeEditor(doc(P(), P("  "), { type: "paragraph", content: [{ type: "hardBreak" }] }, P("x"), { type: "heading", attrs: { level: 2 } }));
    const flags: boolean[] = [];
    e.state.doc.forEach(n => flags.push(isVisuallyEmptyParagraph(n)));
    expect(flags).toEqual([true, true, true, false, false]);
  });
});

describe("只读渲染与保真锁", () => {
  it("remark（WikiMarkdown 同款管线）把 `&nbsp;` 行解析成两个列表之间的段落", () => {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(`1. xxx\n2. yyy\n\n${EMPTY_PARAGRAPH_MD}\n\n1. ppp\n2. qqq`) as { children: { type: string }[] };
    expect(tree.children.map(c => c.type)).toEqual(["list", "paragraph", "list"]);
  });

  it("保真锁安静：nbsp 折叠成空白，签名里不留痕", () => {
    const body = "1. a\n2. b\n\n&nbsp;\n\n1. c";
    const r = checkFidelity(body, toMarkdown(makeEditor(body)));
    expect({ missing: r.missing, added: r.added, lossy: r.lossy }).toEqual({ missing: [], added: [], lossy: false });
    // 存量正文没有 `&nbsp;` 行，序列化出来也不会多出签名项
    const r2 = checkFidelity("甲\n\n乙", toMarkdown(makeEditor(doc(P("甲"), P(), P("乙")))));
    expect(r2.lossy).toBe(false);
  });
});

describe("接线（mock 遮不住的那一层）", () => {
  it("SmartTextarea 关掉 StarterKit 的 paragraph 并挂上 MarkdownParagraph", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf8");
    expect(src).toMatch(/paragraph:\s*false/);
    expect(src).toMatch(/\[base, MarkdownParagraph, markdownExt/);
  });
});
