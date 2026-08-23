// @vitest-environment jsdom
// wiki 图片节点前端面：markdown 正史 ![alt](/__cm__asset:<id>) roundtrip
// （保真锁纪律）+ 编辑器内展示 URL 换算（attrs 恒存原始形态）。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { WikiImage } from "@/lib/tiptap-wiki-image";

function makeEditor(md: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ breaks: true }),
      WikiImage.configure({
        resolveSrc: (src) => {
          const m = /^\/__cm__asset:([^/?#\s]+)$/.exec(src);
          return m ? `/api/production/p1/assets/${m[1]}/thumb` : src;
        },
      }),
    ],
    content: md,
  });
}

describe("wiki 图片 markdown roundtrip", () => {
  function roundtrip(md: string): string {
    const editor = makeEditor(md);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (editor.storage as any).markdown.getMarkdown() as string;
    editor.destroy();
    return out;
  }

  it("![alt](/__cm__asset:<id>) 逐字复原（正文只存 id）", () => {
    const md = "![剧照.jpg](/__cm__asset:as_abc123)";
    expect(roundtrip(md)).toBe(md);
  });

  it("普通外链图片同样无损", () => {
    const md = "![截图](https://example.com/a.png)";
    expect(roundtrip(md)).toBe(md);
  });
});

describe("编辑器内展示 URL 换算", () => {
  it("展示 src 走 thumb 端点，data-cm-src 保留存储形态", () => {
    const editor = makeEditor("![剧照.jpg](/__cm__asset:as_abc123)");
    const html = editor.getHTML();
    editor.destroy();
    expect(html).toContain('src="/api/production/p1/assets/as_abc123/thumb"');
    expect(html).toContain('data-cm-src="/__cm__asset:as_abc123"');
  });

  it("展示态 HTML 回流（编辑器内复制粘贴）经 data-cm-src 还原存储形态", () => {
    const editor = makeEditor("");
    editor.commands.setContent('<img src="/api/production/p1/assets/as_abc123/thumb" data-cm-src="/__cm__asset:as_abc123" alt="剧照.jpg">');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (editor.storage as any).markdown.getMarkdown() as string;
    editor.destroy();
    expect(out).toBe("![剧照.jpg](/__cm__asset:as_abc123)");
  });
});
