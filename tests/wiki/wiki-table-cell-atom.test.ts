// @vitest-environment jsdom
// 表格单元格里只有原子节点时的往返（#694）：# 引用 chip 单独占一格、图片单独占一格
// 保存后不得丢。四面：
//   ① 编辑器：真 tiptap + tiptap-markdown 往返（chip 独占 / 文字+chip / 空格 / 图片独占）
//   ② 反证：换回 TableKit 自带的 table 节点仍丢——护栏活着；上游修了这条会红，提示撤 override
//   ③ 降级分支：合并单元格 / 多块单元格仍委托上游写 HTML，行为不变
//   ④ 接线：SmartTextarea 关掉 TableKit 的 table、挂 MarkdownTable；上游内部方法名静态护栏
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { CjkMarkdown } from "@/lib/editor/tiptap-cjk-markdown";
import { MarkdownContentMentionExt } from "@/lib/editor/tiptap-content-mention";
import { MarkdownTable, hasRenderableInline, isMarkdownSerializable } from "@/lib/editor/tiptap-table-markdown";
import { WikiImage } from "@/lib/wiki/tiptap-image";

type MdStorage = { markdown: { getMarkdown(): string } };

/** 与 SmartTextarea 同一套相关扩展；`fixed=false` 是反证用的 TableKit 原装 table */
function makeEditor(content: string, opts: { fixed?: boolean } = {}) {
  const { fixed = true } = opts;
  const table = fixed
    ? [TableKit.configure({ table: false }), MarkdownTable.configure({ resizable: false })]
    : [TableKit.configure({ table: { resizable: false } })];
  return new Editor({
    extensions: [StarterKit, Markdown.configure({ transformCopiedText: true, breaks: true }), CjkMarkdown,
      ...table, MarkdownContentMentionExt, WikiImage],
    content,
  });
}
const getMarkdown = (e: Editor) => (e.storage as unknown as MdStorage).markdown.getMarkdown();

const CHIP = "[#](/__cm__/block/blk_1)";
const ASSET = "[#](/__cm__/asset/ast_1)";

describe("单元格里只有原子节点：写出且往返稳定", () => {
  const CASES: [string, string][] = [
    ["块引用独占一格", `| 场次 | 引用 |\n| --- | --- |\n| 一 | ${CHIP} |\n`],
    ["asset 引用独占一格", `| 场次 | 引用 |\n| --- | --- |\n| 一 | ${ASSET} |\n`],
    ["引用独占表头格", `| ${CHIP} | 备注 |\n| --- | --- |\n| 甲 | 乙 |\n`],
    ["一格两枚引用、一格文字+引用（现状的绕法不受影响）", `| a | b |\n| --- | --- |\n| ${CHIP}${ASSET} | 见${CHIP} |\n`],
    ["图片独占一格", `| 图 | 说明 |\n| --- | --- |\n| ![封面](/__cm__/asset/ast_2) | 甲 |\n`],
  ];
  for (const [label, md] of CASES) {
    it(label, () => {
      const e1 = makeEditor(md);
      const out1 = getMarkdown(e1);
      expect(out1).toBe(md);
      const e2 = makeEditor(out1);
      expect(getMarkdown(e2)).toBe(md);
      expect(e2.getHTML()).toBe(e1.getHTML());
    });
  }

  it("解析进来的确是 chip 节点，不是普通链接", () => {
    const e = makeEditor(`| a |\n| --- |\n| ${CHIP} |\n`);
    expect(JSON.stringify(e.getJSON())).toContain('"type":"contentMention"');
    expect(JSON.stringify(e.getJSON())).not.toContain('"type":"link"');
  });

  it("空格 / 只有空白的格仍写空（上游行为不变）", () => {
    expect(getMarkdown(makeEditor("<table><tr><th>a</th><th></th></tr><tr><td>  </td><td>x</td></tr></table>")))
      .toBe("| a |  |\n| --- | --- |\n|  | x |\n");
  });

  it("单元格内硬换行仍走 <br>（inTable 赋值没丢）", () => {
    expect(getMarkdown(makeEditor("<table><tr><th>a</th></tr><tr><td>甲<br>乙</td></tr></table>")))
      .toBe("| a |\n| --- |\n| 甲<br>乙 |\n");
  });
});

describe("反证：TableKit 原装 table 节点仍把独占一格的原子节点吞掉", () => {
  // 红了 = 上游修了 `textContent.trim()` 那条判定——届时撤 MarkdownTable，而不是改断言
  it("chip 独占一格被写成空格", () => {
    expect(getMarkdown(makeEditor(`| a |\n| --- |\n| ${CHIP} |\n`, { fixed: false }))).toBe("| a |\n| --- |\n|  |\n");
  });
  it("图片独占一格被写成空格", () => {
    expect(getMarkdown(makeEditor("| a |\n| --- |\n| ![x](/__cm__/asset/ast_2) |\n", { fixed: false }))).toBe("| a |\n| --- |\n|  |\n");
  });
});

describe("降级 HTML 分支委托上游，行为不变", () => {
  const MERGED = '<table><tr><th colspan="2">a</th></tr><tr><td>b</td><td>c</td></tr></table>';
  it("合并单元格：两种装配写出同一份 HTML", () => {
    const fixed = getMarkdown(makeEditor(MERGED));
    expect(fixed).toContain("<table");
    expect(fixed).toContain('colspan="2"');
    expect(fixed).toBe(getMarkdown(makeEditor(MERGED, { fixed: false })));
  });
  it("isMarkdownSerializable：无表头行 / 合并 / 多块单元格都判 false", () => {
    const doc = (html: string) => makeEditor(html).state.doc.firstChild!;
    expect(isMarkdownSerializable(doc("<table><tr><th>a</th></tr><tr><td>b</td></tr></table>"))).toBe(true);
    expect(isMarkdownSerializable(doc("<table><tr><td>a</td></tr></table>"))).toBe(false);
    expect(isMarkdownSerializable(doc(MERGED))).toBe(false);
    expect(isMarkdownSerializable(doc("<table><tr><th>a</th></tr><tr><td><p>b</p><p>c</p></td></tr></table>"))).toBe(false);
  });
  it("hasRenderableInline：原子子节点算有内容，纯空白不算", () => {
    const para = (html: string) => makeEditor(html).state.doc.firstChild!;
    expect(hasRenderableInline(para("<p>  </p>"))).toBe(false);
    expect(hasRenderableInline(para("<p>甲</p>"))).toBe(true);
    expect(hasRenderableInline(para(`<p><a href="/__cm__/block/blk_1">#</a></p>`))).toBe(true);
  });
});

describe("接线", () => {
  it("SmartTextarea：TableKit 关掉 table、紧跟 MarkdownTable", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf8");
    expect(src).toMatch(/TableKit\.configure\(\{ table: false \}\), MarkdownTable\.configure\(/);
    expect(src).not.toMatch(/TableKit\.configure\(\{ table: \{/);
  });
  it("静态护栏：上游仍按 textContent.trim() 判空、serializer 仍有 serializeNode（降级分支靠它）", () => {
    // 前一条红了 = 上游修好，撤 MarkdownTable；后一条红了 = 降级分支拿不到内置实现，得自己写 HTML
    const src = readFileSync("node_modules/tiptap-markdown/dist/tiptap-markdown.es.js", "utf8");
    expect(src).toContain("if (cellContent.textContent.trim()) {");
    expect(src).toMatch(/\n  serializeNode\(node\) \{/);
  });
});
