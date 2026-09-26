// @vitest-environment jsdom
// #526：同一份内容贯穿 HTML 输入、编辑器、只读渲染、引用抽取与保真检测。
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { restoreAndCheckBody } from "@/lib/agent/tools/wiki-dialect-check";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { MarkdownTable } from "@/lib/editor/tiptap-table-markdown";
import { MarkdownParagraph } from "@/lib/editor/tiptap-empty-paragraph";
import { CjkMarkdown } from "@/lib/editor/tiptap-cjk-markdown";
import { Callout } from "@/lib/editor/tiptap-callout";
import { Column, ColumnGroup } from "@/lib/editor/tiptap-columns";
import { INLINE_STYLE_EXTENSIONS } from "@/lib/editor/tiptap-inline-style";
import { WikiImage } from "@/lib/wiki/tiptap-image";
import { MarkdownContentMentionExt } from "@/lib/editor/tiptap-content-mention";
import { parseCellOptions, richTableRanges, richTableProblems, serializeRichTable } from "@/lib/editor/table-dialect";
import { htmlTableToMarkdown, normalizeTableHtml } from "@/lib/editor/table-html";
import { preserveMarkdownSource } from "@/lib/editor/table-source";
import remarkTables from "@/lib/editor/remark-tables";
import remarkColumns from "@/lib/editor/remark-columns";
import { checkFidelity } from "@/lib/wiki/fidelity";
import { extractEmbedAssetIds } from "@/lib/wiki/links";
import type { Fragment } from "@tiptap/pm/model";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach(e => e.destroy()));
function editor(content: string) {
  const e = new Editor({ extensions: [StarterKit.configure({ paragraph: false, underline: false }), MarkdownParagraph,
    Markdown.configure({ breaks: true, transformCopiedText: true }), CjkMarkdown,
    TableKit.configure({ table: false }), MarkdownTable, TaskList, TaskItem.configure({ nested: true }), Callout, Column, ColumnGroup,
    ...INLINE_STYLE_EXTENSIONS, WikiImage, MarkdownContentMentionExt], content });
  editors.push(e);
  return e;
}
const storage = (e: Editor) => (e.storage as unknown as { markdown: { getMarkdown(): string; serializer: { serialize(n: Fragment): string } } }).markdown;
const md = (e: Editor) => storage(e).getMarkdown();
function table(body: string, options = "") {
  return serializeRichTable({ rows: [[{ ...parseCellOptions(options)!, body }]] });
}
const legacy = '<table style="width: 420px"><colgroup><col style="width: 200px"><col style="width: 220px"></colgroup><tbody><tr><td colwidth="200"><img src="/api/assets/a/thumb" data-cm-src="/__cm__/asset/a" alt="图"><p></p></td><td colwidth="220"><p>**字面星号**</p><p>第二段</p></td></tr></tbody></table>';

describe("富表格的同方言往返", () => {
  for (const body of ["第一段\n\n第二段", "- [x] 完成\n- [ ] 待办", "**:::endcell**", "- 甲\n- 乙", "> [!💡]\n>\n> 提示", ":::cols 40,60\n\n左\n\n---\n\n右\n\n:::", '<span style="color:red">红字</span>与<u>下划线</u>', "[#](/__cm__/block/b1)\n\n![图](/__cm__/asset/a)", "~~~md\n:::endcell\n:::endtable\n~~~", "\\:::endcell", table("内层")]) {
    it(`格内 ${body.slice(0, 25)}`, () => {
      const source = table(body);
      const first = editor(source);
      const canonical = md(first);
      const second = editor(canonical);
      expect(second.getJSON()).toEqual(first.getJSON());
      expect(md(second)).toBe(canonical);
      expect(richTableProblems(canonical)).toEqual([]);
      expect(checkFidelity(source, canonical), canonical).toMatchObject({ lossy: false });
    });
  }
  it("历史图排版保留身份、列宽、空段落，二次打开稳定", () => {
    const source = normalizeTableHtml(legacy);
    expect(source).toContain("colwidth=200");
    expect(source).toContain("/__cm__/asset/a");
    expect(source).not.toContain("/api/assets");
    const first = editor(source);
    const canonical = md(first);
    expect(md(editor(canonical))).toBe(canonical);
    expect(checkFidelity(legacy, canonical).lossy).toBe(false);
    expect(extractEmbedAssetIds(legacy)).toEqual(["a"]);
  });
  for (const wrap of [(s: string) => s.split("\n").map(l => "> " + l).join("\n"), (s: string) => "- 开头\n\n" + s.split("\n").map(l => "  " + l).join("\n")]) {
    it("引用或列表内的表格往返", () => {
      const source = wrap(table("甲\n\n乙"));
      const canonical = md(editor(source));
      expect(richTableProblems(canonical)).toEqual([]);
      expect(checkFidelity(source, canonical), canonical).toMatchObject({ lossy: false });
    });
  }
  it("跨行合并与表头保留", () => {
    const source = htmlTableToMarkdown('<table><tr><th rowspan="2">甲</th><td>乙</td></tr><tr><td>丙</td></tr></table>')!;
    expect(source).toContain("header=true rowspan=2");
    expect(checkFidelity(source, md(editor(source))).lossy).toBe(false);
  });
  it("读取 HTML 不把代码例子当成真实表格", () => {
    const source = `~~~html\n${legacy}\n~~~`;
    expect(normalizeTableHtml(source)).toBe(source);
  });
  it("HTML 字面边界转义，未知样式与省略标签保持原文", () => {
    const source = htmlTableToMarkdown("<table><tr><td><p>:::endcell</p></td></tr></table>")!;
    expect(source).toContain("\\:::endcell");
    expect(md(editor(source))).toContain("\\:::endcell");
    expect(htmlTableToMarkdown('<table><tr><td style="background-color:red">字</td></tr></table>')).toBeNull();
    expect(htmlTableToMarkdown("<table><tr><td>甲<td>乙</tr></table>")).toBeNull();
  });
  it("列组宽度与对齐保存，冲突列宽拒绝", () => {
    const source = htmlTableToMarkdown('<table><colgroup><col style="width:120px"></colgroup><tr><td style="text-align:right">字</td></tr></table>')!;
    expect(source).toContain("colwidth=120 align=right");
    expect(checkFidelity(source, md(editor(source))).lossy).toBe(false);
    expect(htmlTableToMarkdown('<table><tr><td colwidth="100">甲</td></tr><tr><td colwidth="200">乙</td></tr></table>')).toBeNull();
  });
  it("引用中的历史 HTML 保留所在引用层级", () => {
    const source = normalizeTableHtml("> " + legacy);
    const first = editor(source);
    expect(first.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(first.state.doc.childCount).toBe(1);
    expect(first.state.doc.firstChild?.firstChild?.type.name).toBe("table");
  });
  it("AI 可写同一套格内方言，拒绝破损边界", () => {
    const source = table("~~~md\n[[仅为示例]]\n:::endcell\n~~~\n\n文字");
    expect(restoreAndCheckBody(source, new Map()).ok).toBe(true);
    expect(restoreAndCheckBody(source.replace(":::endrow", ""), new Map()).ok).toBe(false);
  });
  it("不猜测未知 HTML 内容", () => {
    expect(htmlTableToMarkdown("<table><tr><td><video src='x'></video></td></tr></table>")).toBeNull();
  });
  it("拒绝不完整边界和不齐网格", () => {
    expect(richTableProblems(table("甲").replace(":::endrow", ""))).not.toEqual([]);
    expect(richTableRanges(table("甲").replace(":::cell", ":::cell rowspan=2"))).toEqual([]);
    expect(richTableRanges("```md\n" + table("甲") + "\n```")).toEqual([]);
    expect(richTableRanges(table("甲").replace(":::table", "\\:::table"))).toEqual([]);
  });
  it("保真检测发现交换单元格和丢宽度", () => {
    const a = htmlTableToMarkdown('<table><tr><td colwidth="100">甲</td><td>乙</td></tr></table>')!;
    expect(checkFidelity(a, a.replace("甲", "丙").replace("乙", "甲").replace("丙", "乙")).lossy).toBe(true);
    expect(checkFidelity(a, a.replace(" colwidth=100", "")).lossy).toBe(true);
  });
  it("只读渲染产生真实网格与格内分栏", () => {
    const source = table(":::cols\n\n左\n\n---\n\n右\n\n:::", "colwidth=200");
    const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkTables, remarkColumns]}>{source}</ReactMarkdown>);
    expect(html).toContain("<table");
    expect(html).toContain("<col");
    expect(html).toContain('width:200px');
    expect(html).toContain('wiki-cols');
    expect(html).not.toContain(":::cell");
  });
});

describe("可视化编辑的源码保留", () => {
  it("只改正文时保留历史 HTML 和非标准列表书写", () => {
    const source = `* 原文\n\n${legacy}\n\n末尾`;
    const before = editor(normalizeTableHtml(source));
    const after = editor(normalizeTableHtml(source.replace("末尾", "改后")));
    expect(preserveMarkdownSource(source, before.state.doc, after.state.doc, n => storage(after).serializer.serialize(n))).toBe(source.replace("末尾", "改后"));
  });
  it("未改内容不格式化，修改表格不重写其他块", () => {
    const source = `* 原文\n\n${table("格子")}\n\n尾部`;
    const before = editor(source);
    const after = editor(source.replace("格子", "改格"));
    const serialize = (n: Fragment) => storage(after).serializer.serialize(n);
    expect(preserveMarkdownSource(source, before.state.doc, before.state.doc, serialize)).toBe(source);
    expect(preserveMarkdownSource(source, before.state.doc, after.state.doc, serialize)).toBe(source.replace("格子", "改格"));
  });
});

describe("剪贴板和协作", () => {
  it("HTML 复制保留表格，纯文本复制携带可重开的 Markdown", () => {
    const first = editor(normalizeTableHtml(legacy));
    const clip = first.view.serializeForClipboard(first.state.doc.slice(0, first.state.doc.content.size));
    expect(clip.dom.innerHTML).toContain("<table");
    expect(clip.dom.innerHTML).toContain('data-cm-src="/__cm__/asset/a"');
    expect(clip.text).toContain(":::table");
    expect(md(editor(clip.text))).toBe(md(first));
    expect(md(editor(clip.dom.innerHTML))).toBe(md(first));
  });
  it("代码里的图片不派生挂载边", () => {
    const source = table("~~~md\n![例子](/__cm__/asset/example)\n~~~\n\n![真实](/__cm__/asset/real)");
    expect(extractEmbedAssetIds(source)).toEqual(["real"]);
  });
});
