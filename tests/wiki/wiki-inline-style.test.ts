// @vitest-environment jsdom
// 行内样式方言（#524）：字色 / 底色 / 下划线的 HTML 子集形态，四个落点各一面：
//   ① 方言核心：枚举、canonical、拼法归一化、外来色吸附
//   ② 编辑器：真 tiptap + tiptap-markdown 往返（保真锁纪律）、嵌套顺序、parse 校验
//   ③ 只读渲染：remark 配对 + react-markdown 真渲染
//   ④ 接线：SmartTextarea / EditorOps / globals.css（mock 遮不住的那一层）
// 对抗用例来自 PR #379 的驳回理由：含 @提及的文字上色必须逐字复原且保真锁安静。
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import {
  TEXT_BG_COLORS, TEXT_FG_COLORS, canonicalizeInlineStyleTags, parseCanonicalOpenTag,
  parseStyleColors, snapTextBg, snapTextFg,
} from "@/lib/editor/inline-style-dialect";
import { INLINE_STYLE_EXTENSIONS, INLINE_STYLE_PRIORITY } from "@/lib/editor/tiptap-inline-style";
import remarkInlineStyle, { transformInlineStyle } from "@/lib/editor/remark-inline-style";
import { checkFidelity } from "@/lib/wiki/fidelity";
import { normalizeWikiDialect } from "@/lib/wiki/dialect-migrate";

// ── ① 方言核心 ────────────────────────────────────────────────────────────────

describe("canonical 形态与拼法归一化", () => {
  it("只认三种 canonical 开标签，拼法变体一律不是", () => {
    expect(parseCanonicalOpenTag('<span style="color:red">')).toEqual({ kind: "fg", color: "red" });
    expect(parseCanonicalOpenTag('<span style="background-color:yellow">')).toEqual({ kind: "bg", color: "yellow" });
    expect(parseCanonicalOpenTag("<u>")).toEqual({ kind: "u" });
    for (const bad of ['<span style="color: red">', '<span style="color:red;">', "<span style='color:red'>",
      '<span style="color:#dc2626">', '<span style="background-color:black">', '<span style="color:red;background-color:yellow">',
      '<span class="x">', "<U>", "<font color=\"red\">"]) {
      expect(parseCanonicalOpenTag(bad), bad).toBeNull();
    }
  });

  it("黑色是字色枚举、不是底色枚举；「默认」不在任何枚举里", () => {
    expect(TEXT_FG_COLORS).toContain("black");
    expect(TEXT_BG_COLORS).not.toContain("black");
    expect([...TEXT_FG_COLORS, ...TEXT_BG_COLORS]).not.toContain("default");
  });

  it("parseStyleColors：多余属性 / 非枚举值 → null（不是本方言，别动）", () => {
    expect(parseStyleColors("color: Red;")).toEqual({ fg: "red", bg: null });
    expect(parseStyleColors("background: yellow")).toEqual({ fg: null, bg: "yellow" });
    expect(parseStyleColors("color:red; font-weight:bold")).toBeNull();
    expect(parseStyleColors("color:#f00")).toBeNull();
    expect(parseStyleColors("")).toBeNull();
  });

  it("canonicalizeInlineStyleTags：能无损收的收，其余原样，幂等", () => {
    const cases: [string, string][] = [
      ['甲<span style="color: Red;">乙</span>', '甲<span style="color:red">乙</span>'],
      ["<span style='background: yellow'>乙</span>", '<span style="background-color:yellow">乙</span>'],
      ["<U>乙</U>", "<u>乙</u>"],
      ['<span style="color:#dc2626">乙</span>', '<span style="color:#dc2626">乙</span>'],
      // 合写的字色+底色不收（要改成两层得配对改闭标签，字符串层做不可靠）
      ['<span style="color:red;background-color:yellow">乙</span>', '<span style="color:red;background-color:yellow">乙</span>'],
      ['<span class="x" style="color:red">乙</span>', '<span class="x" style="color:red">乙</span>'],
    ];
    for (const [input, expected] of cases) {
      const once = canonicalizeInlineStyleTags(input);
      expect(once, input).toBe(expected);
      expect(canonicalizeInlineStyleTags(once), `幂等：${input}`).toBe(expected);
    }
  });

  it("normalizeWikiDialect 走同一归一化，且不碰代码段", () => {
    expect(normalizeWikiDialect('甲<span style="color: red;">乙</span>')).toBe('甲<span style="color:red">乙</span>');
    const code = '`<span style="color: red;">`';
    expect(normalizeWikiDialect(code)).toBe(code);
  });
});

describe("外来颜色吸附（飞书色板实测值）", () => {
  it("字色：飞书七色各归其桶，默认字色 #1f2329 = 默认（不落标签）", () => {
    expect(snapTextFg("rgb(216, 57, 49)")).toBe("red");     // #d83931
    expect(snapTextFg("#de7802")).toBe("orange");
    expect(snapTextFg("#dc9b04")).toBe("yellow");            // h≈42，桶边界 40 校过
    expect(snapTextFg("#2ea121")).toBe("green");
    expect(snapTextFg("#245bdb")).toBe("blue");
    expect(snapTextFg("#6425d0")).toBe("purple");
    expect(snapTextFg("#8f959e")).toBe("gray");
    expect(snapTextFg("#1f2329")).toBe("default");
    expect(snapTextFg("rgb(0,0,0)")).toBe("default");
    expect(snapTextFg("")).toBeNull();
    expect(snapTextFg("var(--x)")).toBeNull();
  });

  it("底色：飞书淡色底各归其桶，灰底是灰不是默认，白底 / 透明 = 默认", () => {
    expect(snapTextBg("#fbbfbc")).toBe("red");
    expect(snapTextBg("#fed4a4")).toBe("orange");
    expect(snapTextBg("#fff67a")).toBe("yellow");
    expect(snapTextBg("#b7edb1")).toBe("green");
    expect(snapTextBg("#bacefd")).toBe("blue");
    expect(snapTextBg("#cdb2fa")).toBe("purple");
    expect(snapTextBg("#eff0f1")).toBe("gray");
    expect(snapTextBg("#ffffff")).toBe("default");
    expect(snapTextBg("transparent")).toBe("default");
    expect(snapTextBg("rgba(0,0,0,0)")).toBe("default");
  });
});

// ── ② 编辑器 ──────────────────────────────────────────────────────────────────

function makeEditor(content?: string) {
  return new Editor({
    extensions: [StarterKit.configure({ underline: false }), ...INLINE_STYLE_EXTENSIONS, Markdown.configure({ breaks: true })],
    ...(content !== undefined ? { content } : {}),
  });
}
function md(editor: Editor): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (editor.storage as any).markdown.getMarkdown() as string;
}
function roundtrip(input: string): string {
  const e = makeEditor(input);
  const out = md(e);
  e.destroy();
  return out;
}

describe("editor roundtrip（保真锁纪律）", () => {
  const CANONICAL = [
    '甲<span style="color:red">乙</span>丙',
    '甲<span style="background-color:yellow">乙</span>丙',
    "甲<u>乙</u>丙",
    // 用户给的嵌套例：黄底一段里套红字
    '<span style="background-color:yellow">这是一段<span style="color:red">红色</span>的字</span>',
    // 三层全套 + 加粗斜体在最里面
    '甲<span style="background-color:yellow"><span style="color:red"><u>***乙***</u></span></span>丙',
    // #379 的对抗用例：含 @提及（引用链接）的文字上色
    '甲<span style="color:red">见 [@张三](/__cm__/user/u1) 的</span>丙',
    '甲<span style="color:red">见 [#](/__cm__/wiki/3fa85f64-5717-4562-b3fc-2c963f66afa6) 一节</span>丙',
    // 加粗里套色：序列化后色在外、粗在内（mark 次序），再解析回同一形态
    '甲<span style="color:red">**乙**</span>丙',
    '甲**乙<span style="color:red">丙</span>丁**戊',
    // 相邻同色、含空格
    '甲<span style="color:red">乙</span><span style="color:blue">丙</span>丁',
    '甲<span style="color:red">乙 </span>丙',
    // 行内代码是非 mixable mark，样式壳在它两侧断开重开——这就是 canonical；
    // 码内的 `</span>` 是字面，不参与配对
    '甲<span style="color:red">乙</span>`</span>`<span style="color:red">丙</span>丁',
  ];
  it.each(CANONICAL)("逐字复原 + 保真锁安静：%s", (input) => {
    const out = roundtrip(input);
    expect(out).toBe(input);
    expect(checkFidelity(input, out).lossy).toBe(false);
  });

  it("拼法变体：载入归一化后进编辑器，写出 canonical，保真锁对原文也安静", () => {
    const raw = '甲<span style="color: Red;">乙</span>丙';
    const out = roundtrip(normalizeWikiDialect(raw));
    expect(out).toBe('甲<span style="color:red">乙</span>丙');
    expect(checkFidelity(raw, out).lossy).toBe(false);
  });

  it("加粗写在样式标签外面（中文上下文）解析不回加粗——这是 CommonMark 侧翼规则，所以 canonical 让样式永远在外", () => {
    // 不是我们的 bug，但要钉住：serializer 绝不能产出这种形态
    const out = roundtrip('甲**<span style="color:red">乙</span>**丙');
    expect(out).not.toContain("**<span");
  });

  it("mark 次序：底色 > 字色 > 下划线 > link > bold（priority 决定，也就是 canonical 的嵌套顺序）", () => {
    const e = makeEditor();
    const order = Object.keys(e.schema.marks);
    e.destroy();
    const idx = (n: string) => order.indexOf(n);
    expect(idx("textBackground")).toBeLessThan(idx("textColor"));
    expect(idx("textColor")).toBeLessThan(idx("underline"));
    expect(idx("underline")).toBeLessThan(idx("link"));
    expect(idx("link")).toBeLessThan(idx("bold"));
    expect(INLINE_STYLE_PRIORITY.textBackground).toBeGreaterThan(INLINE_STYLE_PRIORITY.textColor);
    expect(INLINE_STYLE_PRIORITY.textColor).toBeGreaterThan(INLINE_STYLE_PRIORITY.underline);
    expect(INLINE_STYLE_PRIORITY.underline).toBeGreaterThan(1000); // Link 是 1000
  });

  it("「默认颜色」= 去壳：unset 后正文里没有 span", () => {
    const e = makeEditor("甲乙丙");
    e.commands.setTextSelection({ from: 2, to: 3 });
    e.commands.setTextColor("red");
    expect(md(e)).toBe('甲<span style="color:red">乙</span>丙');
    e.commands.unsetTextColor();
    expect(md(e)).toBe("甲乙丙");
    e.commands.setTextBackground("yellow");
    e.commands.setTextColor("blue");
    expect(md(e)).toBe('甲<span style="background-color:yellow"><span style="color:blue">乙</span></span>丙');
    e.commands.unsetTextColor(); // 只去字色，底色壳还在
    expect(md(e)).toBe('甲<span style="background-color:yellow">乙</span>丙');
    e.destroy();
  });

  it("parse 路径也校验：hex / 未知色名 / 伪造 data-fg 一律不进 attrs，文字保留", () => {
    for (const html of [
      '<p>甲<span style="color:#ff0000">乙</span>丙</p>',
      '<p>甲<span style="color:pink">乙</span>丙</p>',
      '<p>甲<span data-fg="red;position:fixed">乙</span>丙</p>',
      '<p>甲<span style="background-color:black">乙</span>丙</p>',
    ]) {
      const e = makeEditor(html);
      expect(md(e), html).toBe("甲乙丙");
      e.destroy();
    }
  });

  it("setTextColor 拒绝枚举外的值（命令层是第二道门）", () => {
    const e = makeEditor("甲乙丙");
    e.commands.setTextSelection({ from: 2, to: 3 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(e.commands.setTextColor("#ff0000" as any)).toBe(false);
    expect(md(e)).toBe("甲乙丙");
    e.destroy();
  });

  it("⌘U 走的是我们的 underline：toggleUnderline 写出 <u>，且 StarterKit 那份已关", () => {
    const e = makeEditor("甲乙丙");
    e.commands.setTextSelection({ from: 2, to: 3 });
    e.commands.toggleUnderline();
    expect(md(e)).toBe("甲<u>乙</u>丙");
    expect(e.extensionManager.extensions.filter(x => x.name === "underline")).toHaveLength(1);
    e.destroy();
  });

  it("renderHTML 不漏内部属性：编辑态 DOM 只有 data-fg / data-bg", () => {
    const e = makeEditor('甲<span style="background-color:yellow"><span style="color:red">乙</span></span>丙');
    expect(e.getHTML()).toBe('<p>甲<span data-bg="yellow"><span data-fg="red">乙</span></span>丙</p>');
    e.destroy();
  });
});

// ── ③ 只读渲染 ────────────────────────────────────────────────────────────────

type Md = { type: string; value?: string; children?: Md[]; data?: { hName?: string; hProperties?: Record<string, unknown> } };
function mdast(input: string): Md {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(input) as unknown as Md;
  transformInlineStyle(tree);
  return tree;
}
function render(input: string): string {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkInlineStyle] }, input));
}

describe("remark 配对（只读端）", () => {
  it("三种 canonical 标签配成 span[data-fg] / span[data-bg] / u，嵌套保留", () => {
    const html = render('<span style="background-color:yellow">这是一段<span style="color:red">红色</span>的字</span>');
    expect(html).toBe('<p><span data-bg="yellow">这是一段<span data-fg="red">红色</span>的字</span></p>');
    expect(render("甲<u>**乙**</u>丙")).toBe("<p>甲<u><strong>乙</strong></u>丙</p>");
  });

  it("拼法不是 canonical / 落单 / 跨父节点：留字面（降级可见不吃字）", () => {
    expect(render('甲<span style="color: red">乙</span>丙')).toContain("&lt;span style=&quot;color: red&quot;&gt;乙&lt;/span&gt;");
    expect(render('甲<span style="color:red">乙')).toContain("&lt;span style=&quot;color:red&quot;&gt;乙");
    expect(render("甲</span>乙")).toContain("&lt;/span&gt;");
    // 开在段落一、闭在段落二：不配对
    const two = render('<span style="color:red">甲\n\n乙</span>');
    expect(two).not.toContain("data-fg");
    expect(two).toContain("甲");
    expect(two).toContain("乙");
  });

  it("不解释任何别的 HTML：<span class> / <font> / <div> 照旧是文字", () => {
    for (const raw of ['<span class="x">甲</span>', '<font color="red">甲</font>', "<div>甲</div>"]) {
      const html = render(raw);
      expect(html).not.toMatch(/<(span|font|div)/);
      expect(html).toContain("甲");
    }
  });

  it("mdast 层：hProperties 落 dataFg / dataBg（property-information 命名）", () => {
    const tree = mdast('<span style="color:blue">乙</span>');
    const p = tree.children![0];
    expect(p.children![0].type).toBe("inlineStyle");
    expect(p.children![0].data).toEqual({ hName: "span", hProperties: { dataFg: "blue" } });
  });
});

// ── ④ 接线 ────────────────────────────────────────────────────────────────────

describe("接线（mock 遮不住的那一层）", () => {
  it("SmartTextarea 关掉 StarterKit 的 underline 并挂上三个样式 mark", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf8");
    expect(src).toMatch(/underline:\s*false/);
    expect(src).toContain("...INLINE_STYLE_EXTENSIONS");
  });
  it("浮动条有下划线与颜色入口，且色板里「默认」不是黑块", () => {
    const src = readFileSync("components/editor/EditorOps.tsx", "utf8");
    expect(src).toContain("toggleUnderline()");
    expect(src).toContain("unsetTextColor()");
    expect(src).toContain("unsetTextBackground()");
    expect(src).toContain("字体颜色：默认");
    expect(src).toContain("背景颜色：默认");
  });
  it("只读渲染挂了 remarkInlineStyle、没有 rehype-raw", () => {
    const src = readFileSync("components/wiki/WikiMarkdown.tsx", "utf8");
    expect(src).toMatch(/remarkPlugins=\{\[.*remarkInlineStyle\]\}/);
    expect(src).not.toMatch(/from ["']rehype-raw["']/);
  });
  it("globals.css 对每个枚举值都有变量与 data-fg / data-bg 规则（hex 只在这一处）", () => {
    const css = readFileSync("app/globals.css", "utf8");
    for (const c of TEXT_FG_COLORS) {
      expect(css, c).toMatch(new RegExp(`--text-fg-${c}:\\s*#[0-9a-fA-F]{6};`));
      expect(css, c).toContain(`[data-fg="${c}"]`);
    }
    for (const c of TEXT_BG_COLORS) {
      expect(css, c).toMatch(new RegExp(`--text-bg-${c}:\\s*#[0-9a-fA-F]{6};`));
      expect(css, c).toContain(`[data-bg="${c}"]`);
    }
    // 方言核心与 mark 里不许出现 hex
    for (const f of ["lib/editor/inline-style-dialect.ts", "lib/editor/tiptap-inline-style.ts", "components/editor/EditorOps.tsx"]) {
      const body = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(body, f).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    }
  });
});
