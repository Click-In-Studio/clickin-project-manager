// @vitest-environment jsdom
// 加粗 / 斜体 / 删除线嵌套且两侧紧贴中文的往返（#674）。四个落点各一面：
//   ① 编辑器：真 tiptap + tiptap-markdown 往返（issue 表格六条 + 变体）、空白外推仍在、
//      表格 / 列表 / 代码块不受序列化路径替换影响、剪贴板切片同路径、装配顺序无关
//   ② 反证：不挂 CjkMarkdown 的编辑器仍毁字——护栏活着；上游哪天修了这条会红，提示撤 workaround
//   ③ 只读侧：remark 两个 CJK 插件让紧贴中文的加粗 / 删除线解析成结构；保真锁两侧签名一致；
//      通知文档解析同源
//   ④ 接线：六处落点（mock 遮不住的那一层）
// 已知限制也写成用例：纯 ASCII 紧贴嵌套 CommonMark 本来就表示不了，仍 lossy，但保真锁必须响。
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import remarkParse from "remark-parse";
import markdownit from "markdown-it";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { INLINE_STYLE_EXTENSIONS } from "@/lib/editor/tiptap-inline-style";
import { CjkMarkdown, applyCjkFriendly } from "@/lib/editor/tiptap-cjk-markdown";
import { REMARK_CJK_PLUGINS } from "@/lib/editor/remark-cjk-friendly";
import { checkFidelity, contentSignature } from "@/lib/wiki/fidelity";
import { renderNotifyDoc } from "@/lib/notify/doc/from-markdown";
import { toEmailHtml } from "@/lib/notify/doc/platform-html";

type MdStorage = { markdown: { getMarkdown(): string; serializer: { serialize(c: unknown): string } } };

/** 与 SmartTextarea 同一套相关扩展；`cjk=false` 是反证用的裸 tiptap-markdown */
function makeEditor(content: string, opts: { cjk?: boolean; cjkFirst?: boolean } = {}) {
  const { cjk = true, cjkFirst = false } = opts;
  const md = Markdown.configure({ transformCopiedText: true, breaks: true });
  const core = cjkFirst ? [CjkMarkdown, StarterKit, md] : [StarterKit, md, ...(cjk ? [CjkMarkdown] : [])];
  return new Editor({
    extensions: [...core, TableKit.configure({ table: { resizable: false } }), ...INLINE_STYLE_EXTENSIONS],
    content,
  });
}
const getMarkdown = (e: Editor) => (e.storage as unknown as MdStorage).markdown.getMarkdown();

/** HTML → markdown → 再解析 → 再序列化，回 {md1, md2, html1, html2, fidelity} */
function roundtrip(html: string, opts?: { cjkFirst?: boolean }) {
  const e1 = makeEditor(html, opts);
  const md1 = getMarkdown(e1);
  const e2 = makeEditor(md1, opts);
  const md2 = getMarkdown(e2);
  return { md1, md2, html1: e1.getHTML(), html2: e2.getHTML(), fidelity: checkFidelity(md1, md2) };
}

// ── ① 编辑器往返 ─────────────────────────────────────────────────────────────

describe("嵌套 mark 紧贴中文：写出正确形态且往返无损", () => {
  const CASES: [string, string, string][] = [
    // [说明, 输入 HTML, 期望的 markdown]
    ["加粗+删除线（issue 第一行）", "甲<strong><s>乙</s></strong>丙", "甲**~~乙~~**丙"],
    ["删除线在外、加粗在内——序列化按 schema 次序，形态同上", "甲<s><strong>乙</strong></s>丙", "甲**~~乙~~**丙"],
    ["斜体+删除线（issue 里「丙」被吃的那条）", "甲<em><s>乙</s></em>丙", "甲*~~乙~~*丙"],
    ["加粗+斜体+删除线三层", "甲<em><strong><s>乙</s></strong></em>丙", "甲***~~乙~~***丙"],
    ["加粗+下划线（#675 已修，不得回退）", "甲<strong><u>乙</u></strong>丙", "甲<u>**乙**</u>丙"],
    ["加粗+斜体不受影响", "甲<strong><em>乙</em></strong>丙", "甲***乙***丙"],
    ["单层加粗紧贴中文", "甲<strong>乙</strong>丙", "甲**乙**丙"],
    ["单层删除线紧贴中文", "甲<s>乙</s>丙", "甲~~乙~~丙"],
    ["加粗紧贴全角标点", "甲<strong>乙</strong>，丙", "甲**乙**，丙"],
    // 定界符内侧是全角标点：CommonMark 原规则两侧解析器都不认，靠 CJK 侧翼规则
    ["加粗含句号（选中整句加粗的常态）", "甲<strong>乙。</strong>丙", "甲**乙。**丙"],
    ["加粗含括号", "甲<strong>（乙）</strong>丙", "甲**（乙）**丙"],
    ["删除线含引号", "甲<s>「乙」</s>丙", "甲~~「乙」~~丙"],
    ["加粗被全角引号包着", "「<strong>乙</strong>」", "「**乙**」"],
    ["两侧有空格（本来就正常）", "甲 <strong><s>乙</s></strong> 丙", "甲 **~~乙~~** 丙"],
  ];
  for (const [label, html, expected] of CASES) {
    it(label, () => {
      const r = roundtrip(html);
      expect(r.md1, "第一次序列化").toBe(expected);
      expect(r.md2, "第二次序列化").toBe(expected);
      expect(r.html2, "再解析后的文档").toBe(r.html1);
      expect(r.fidelity.lossy, `保真锁必须安静：${JSON.stringify(r.fidelity)}`).toBe(false);
    });
  }

  it("首尾空白外推仍在：不是靠关 expelEnclosingWhitespace 换来的", () => {
    // 「选中一个词连带尾空格再加粗」是日常路径，关掉开关会写成 `**乙 **丙`、加粗丢失
    expect(roundtrip("甲<strong>乙 </strong>丙").md1).toBe("甲**乙** 丙");
    expect(roundtrip("甲<strong> 乙</strong>丙").md1).toBe("甲 **乙**丙");
    expect(roundtrip("甲<strong>乙 </strong>丙").html2).toBe("<p>甲<strong>乙</strong> 丙</p>");
  });

  it("序列化路径替换不碰表格内换行（inTable）、列表硬换行、代码块", () => {
    const table = roundtrip("<table><tr><th>a</th><th>b</th></tr><tr><td>甲<br>乙</td><td>x</td></tr></table>");
    expect(table.md1).toBe("| a | b |\n| --- | --- |\n| 甲<br>乙 | x |\n");
    expect(table.html2).toBe(table.html1);
    const list = roundtrip("<ul><li>甲<br>乙</li><li>丙</li></ul>");
    expect(list.md1).toBe("- 甲\\\n  乙\n- 丙");
    expect(list.html2).toBe(list.html1);
    const code = roundtrip("<pre><code>x **y** z</code></pre>");
    expect(code.md1).toBe("```\nx **y** z\n```");
    expect(code.html2).toBe(code.html1);
  });

  it("剪贴板切片（serializer.serialize(Fragment)）走同一条路径", () => {
    const e = makeEditor("甲<strong><s>乙</s></strong>丙");
    const slice = (e.storage as unknown as MdStorage).markdown.serializer.serialize(e.state.doc.content);
    expect(slice).toBe("甲**~~乙~~**丙");
  });

  it("装配顺序无关：CjkMarkdown 写在 Markdown 扩展前面也一样（priority 严格低于它的 50）", () => {
    expect(roundtrip("甲<strong><s>乙</s></strong>丙", { cjkFirst: true }).md1).toBe("甲**~~乙~~**丙");
  });

  it("applyCjkFriendly 幂等：同一 markdown-it 实例反复 setup 只替换一次 State", () => {
    const md = markdownit();
    const original = md.inline.State;
    applyCjkFriendly(md);
    const patched = md.inline.State;
    expect(patched).not.toBe(original);
    expect(Object.getPrototypeOf(patched)).toBe(original);
    applyCjkFriendly(md);
    applyCjkFriendly(md);
    expect(md.inline.State).toBe(patched);
  });
});

// ── ② 反证 ───────────────────────────────────────────────────────────────────

describe("反证：不挂 CjkMarkdown 的裸 tiptap-markdown 仍毁字", () => {
  // 这组红了意味着上游修好了 trimInline——那就该撤掉 serializeWithoutTrimInline，而不是改断言
  it("trimInline 把外层定界符挪进内层", () => {
    expect(getMarkdown(makeEditor("甲<strong><s>乙</s></strong>丙", { cjk: false }))).toBe("甲**~~乙~~~~丙");
    expect(getMarkdown(makeEditor("甲<em><s>乙</s></em>丙", { cjk: false }))).toBe("甲*~~乙~~~~");
  });
  it("裸 markdown-it 解析不回 `甲**~~乙~~**丙`、`甲**乙。**丙`（CommonMark 侧翼规则）", () => {
    expect(makeEditor("甲**~~乙~~**丙", { cjk: false }).getHTML()).not.toContain("<strong>");
    expect(makeEditor("甲**乙。**丙", { cjk: false }).getHTML()).not.toContain("<strong>");
  });
});

describe("已知限制：纯 ASCII 紧贴嵌套", () => {
  it("CommonMark / GFM 表示不了，仍 lossy，但保真锁必须响（不再静默毁字）", () => {
    const r = roundtrip("a<strong><s>b</s></strong>c");
    expect(r.md1).toBe("a**~~b~~**c");
    expect(r.fidelity.lossy).toBe(true);
  });
});

// ── ③ 只读侧 ─────────────────────────────────────────────────────────────────

describe("remark 侧 CJK 规则", () => {
  const parse = (md: string, cjk: boolean) => {
    let p = unified().use(remarkParse).use(remarkGfm);
    if (cjk) p = p.use([...REMARK_CJK_PLUGINS]);
    return JSON.stringify(p.parse(md));
  };
  it("紧贴中文的加粗 + 删除线解析成 strong > delete", () => {
    const on = parse("甲**~~乙~~**丙", true);
    expect(on).toContain('"type":"strong"');
    expect(on).toContain('"type":"delete"');
  });
  it("反证：定界符内侧是全角标点时，不挂插件两个包各自都是字面", () => {
    // `**~~` 相邻 micromark 本来就认（与 markdown-it 不同），所以反证要用标点用例：
    // 句号那条由 remark-cjk-friendly 修，引号 + `~~` 那条由 gfm-strikethrough 那个包修
    expect(parse("甲**乙。**丙", false)).not.toContain('"type":"strong"');
    expect(parse("甲**乙。**丙", true)).toContain('"type":"strong"');
    expect(parse("甲~~「乙」~~丙", false)).not.toContain('"type":"delete"');
    expect(parse("甲~~「乙」~~丙", true)).toContain('"type":"delete"');
  });
  it("react-markdown 真渲染（WikiMarkdown 同一插件顺序）出 strong > del", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, ...REMARK_CJK_PLUGINS] }, "甲**~~乙~~**丙"),
    );
    expect(html).toBe("<p>甲<strong><del>乙</del></strong>丙</p>");
  });
  it("保真锁两侧签名一致：编辑器写出的形态在 remark 眼里就是「甲 乙 丙」", () => {
    expect(contentSignature("甲**~~乙~~**丙")).toEqual(["甲", "乙", "丙"]);
    expect(contentSignature("甲*~~乙~~*丙")).toEqual(["甲", "乙", "丙"]);
    expect(contentSignature("甲**乙。**丙")).toEqual(["甲", "乙。", "丙"]);
  });
  it("通知文档解析同源：紧贴中文的加粗在邮件里是 <strong>", async () => {
    const d = await renderNotifyDoc("甲**乙。**丙", async () => null);
    expect(toEmailHtml(d)).toContain("<strong>乙。</strong>");
  });
});

// ── ④ 接线 ───────────────────────────────────────────────────────────────────

describe("接线（mock 遮不住的那一层）", () => {
  it("两个 tiptap 编辑器都挂了 CjkMarkdown", () => {
    expect(readFileSync("components/editor/SmartTextarea.tsx", "utf8")).toMatch(/markdownExt,\s*CjkMarkdown/);
    expect(readFileSync("components/ui/Markdown.tsx", "utf8")).toContain("CjkMarkdown");
  });
  it("四处 remark 都挂了 REMARK_CJK_PLUGINS，且排在 remarkGfm 之后", () => {
    expect(readFileSync("components/wiki/WikiMarkdown.tsx", "utf8")).toMatch(/remarkPlugins=\{\[remarkGfm, \.\.\.REMARK_CJK_PLUGINS,/);
    expect(readFileSync("components/help/HelpMarkdown.tsx", "utf8")).toMatch(/remarkPlugins=\{\[remarkGfm, \.\.\.REMARK_CJK_PLUGINS,/);
    expect(readFileSync("lib/wiki/fidelity.ts", "utf8")).toMatch(/use\(remarkGfm\)\.use\(\[\.\.\.REMARK_CJK_PLUGINS\]\)/);
    expect(readFileSync("lib/notify/doc/from-markdown.ts", "utf8")).toMatch(/use\(remarkGfm\)\.use\(\[\.\.\.REMARK_CJK_PLUGINS\]\)/);
  });
  it("序列化替换真的落到了实例上（不是靠往返结果间接推断）", () => {
    const e = makeEditor("甲");
    const serializer = (e.storage as unknown as MdStorage).markdown.serializer;
    expect(Object.prototype.hasOwnProperty.call(serializer, "serialize")).toBe(true);
    const bare = (makeEditor("甲", { cjk: false }).storage as unknown as MdStorage).markdown.serializer;
    expect(Object.prototype.hasOwnProperty.call(bare, "serialize")).toBe(false);
  });
  it("静态护栏：tiptap-markdown 的 Markdown 扩展仍声明 priority 50，CjkMarkdown 严格更低", () => {
    // 升 tiptap-markdown 后这条红了：去核它新的 priority，把 CjkMarkdown 的压到更低，再改这里
    const src = readFileSync("node_modules/tiptap-markdown/dist/tiptap-markdown.es.js", "utf8");
    expect(src).toMatch(/name: "markdown",\s*priority: 50,/);
    expect(CjkMarkdown.config.priority).toBeLessThan(50);
  });
});
