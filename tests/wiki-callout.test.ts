// @vitest-environment jsdom
// callout 方言（> [!emoji|#color]）三面测试：marker 解析/DOM 提升、
// 编辑器真实 roundtrip（保真锁纪律：解析→再序列化必须逐字复原）、飞书粘贴映射。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Callout, CALLOUT_MARKER_RE, formatCalloutMarker, promoteCalloutBlockquotes } from "@/lib/tiptap-callout";
import { transformFeishuHtml } from "@/lib/feishu-paste";

describe("callout marker", () => {
  it("emoji+color / 仅 emoji / 空 emoji / GitHub alerts 形态全部命中", () => {
    expect("[!🍰|#fff5eb]".match(CALLOUT_MARKER_RE)?.slice(1)).toEqual(["🍰", "#fff5eb"]);
    expect("[!📌]".match(CALLOUT_MARKER_RE)?.[1]).toBe("📌");
    expect("[!]".match(CALLOUT_MARKER_RE)?.[1]).toBe("");
    expect("[!note]".match(CALLOUT_MARKER_RE)?.[1]).toBe("note");
  });
  it("普通文字与链接语法不命中", () => {
    expect("[!未闭合".match(CALLOUT_MARKER_RE)).toBeNull();
    expect("[链接](x)".match(CALLOUT_MARKER_RE)).toBeNull();
  });
  it("formatCalloutMarker 与正则互逆", () => {
    for (const [emoji, color] of [["🍰", "#fff5eb"], ["📌", null], ["", null], ["note", null]] as const) {
      const m = formatCalloutMarker(emoji, color).match(CALLOUT_MARKER_RE)!;
      expect(m[1]).toBe(emoji);
      expect(m[2] ?? null).toBe(color);
    }
  });
});

describe("promoteCalloutBlockquotes", () => {
  function run(html: string): string {
    const root = document.createElement("div");
    root.innerHTML = html;
    promoteCalloutBlockquotes(root);
    return root.innerHTML;
  }

  it("marker 独占一行 + 同段内容（remark/markdown-it breaks 形态）", () => {
    const out = run("<blockquote><p>[!🍰|#fff5eb]<br>内容行</p></blockquote>");
    expect(out).toContain('data-callout=""');
    expect(out).toContain('data-emoji="🍰"');
    expect(out).toContain('data-color="#fff5eb"');
    expect(out).toContain("内容行");
    expect(out).not.toContain("[!");
    expect(out).not.toContain("<blockquote>");
  });

  it("marker 段独立、内容为后续段落", () => {
    const out = run("<blockquote><p>[!📌]</p><p>第二段</p></blockquote>");
    expect(out).toContain('data-emoji="📌"');
    expect(out).toContain("<p>第二段</p>");
    expect(out).not.toMatch(/<p>\s*<\/p>/);
  });

  it("普通 blockquote 原样不动", () => {
    const html = "<blockquote><p>只是引用</p></blockquote>";
    expect(run(html)).toBe(html);
  });
});

describe("editor roundtrip（保真锁纪律）", () => {
  function roundtrip(md: string): string {
    const editor = new Editor({
      extensions: [StarterKit, Markdown.configure({ breaks: true }), Callout],
      content: md,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (editor.storage as any).markdown.getMarkdown() as string;
    editor.destroy();
    return out;
  }

  it("emoji+color callout 逐字复原", () => {
    const md = "> [!🍰|#fff5eb]\n> 内容行";
    expect(roundtrip(md)).toBe(md);
  });

  it("默认色 callout 与多行内容复原", () => {
    // 软换行序列化为 "\\\n" 是 tiptap-markdown 既有行为（全编辑器一致），
    // WikiDocClient 保真对比已显式等价之——按同款归一化断言
    const md = "> [!📌]\n> 第一行\n> 第二行";
    expect(roundtrip(md).replace(/\\\n/g, "\n")).toBe(md);
  });

  it("GitHub alerts 写法不被归一化改写", () => {
    const md = "> [!note]\n> 提示内容";
    expect(roundtrip(md)).toBe(md);
  });

  it("普通引用块不受影响", () => {
    const md = "> 只是引用";
    expect(roundtrip(md)).toBe(md);
  });
});

describe("飞书 callout 粘贴映射", () => {
  const feishu = (emojiId: string, bg: string, inner: string) =>
    `<div data-lark-html-role="root"><div class="zoneType-calloutBlock"><div class="callout-container" data-emoji-id="${emojiId}"><div class="callout-block" style="background-color:${bg};border-color:rgb(239,240,241);border-radius:8px;">${inner}</div></div></div></div>`;

  it("默认灰底：emoji 映射、不落 data-color", () => {
    const out = transformFeishuHtml(feishu("cake", "rgb(245,246,247)", '<div class="ace-line">内容</div>'));
    expect(out).toContain('data-callout=""');
    expect(out).toContain('data-emoji="🍰"');
    expect(out).not.toContain("data-color");
    expect(out).toContain("内容");
    expect(out).not.toContain("zoneType-calloutBlock");
  });

  it("非默认底色：rgb 归一化为 hex 落 data-color", () => {
    const out = transformFeishuHtml(feishu("pushpin", "rgb(255,245,235)", "<div>aaa</div>"));
    expect(out).toContain('data-emoji="📌"');
    expect(out).toContain('data-color="#fff5eb"');
  });

  it("未收录 emoji 落默认 💡，多行内容全保留", () => {
    const out = transformFeishuHtml(feishu("some_new_emoji", "rgb(245,246,247)", "<div>甲</div><div>乙</div>"));
    expect(out).toContain('data-emoji="💡"');
    expect(out).toContain("甲");
    expect(out).toContain("乙");
  });
});
