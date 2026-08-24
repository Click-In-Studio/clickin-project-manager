// @vitest-environment jsdom
// wiki 图片节点前端面：markdown 正史 ![alt](/__cm__/asset/<id>) roundtrip
// （保真锁纪律）+ 编辑器内展示 URL 换算（attrs 恒存原始形态）。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { WikiImage } from "@/lib/tiptap-wiki-image";
import { decodeAssetSrc } from "@/lib/mention-types";

function makeEditor(md: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ breaks: true }),
      WikiImage.configure({
        resolveSrc: (src) => {
          const id = decodeAssetSrc(src);
          return id ? `/api/production/p1/assets/${id}/thumb` : src;
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

  it("![alt](/__cm__/asset/<id>) 逐字复原（正文只存 id）", () => {
    const md = "![剧照.jpg](/__cm__/asset/as_abc123)";
    expect(roundtrip(md)).toBe(md);
  });

  it("普通外链图片同样无损", () => {
    const md = "![截图](https://example.com/a.png)";
    expect(roundtrip(md)).toBe(md);
  });
});

describe("编辑器内展示 URL 换算", () => {
  it("展示 src 走 thumb 端点，data-cm-src 保留存储形态", () => {
    const editor = makeEditor("![剧照.jpg](/__cm__/asset/as_abc123)");
    const html = editor.getHTML();
    editor.destroy();
    expect(html).toContain('src="/api/production/p1/assets/as_abc123/thumb"');
    expect(html).toContain('data-cm-src="/__cm__/asset/as_abc123"');
  });

  it("展示态 HTML 回流（编辑器内复制粘贴）经 data-cm-src 还原存储形态", () => {
    const editor = makeEditor("");
    editor.commands.setContent('<img src="/api/production/p1/assets/as_abc123/thumb" data-cm-src="/__cm__/asset/as_abc123" alt="剧照.jpg">');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (editor.storage as any).markdown.getMarkdown() as string;
    editor.destroy();
    expect(out).toBe("![剧照.jpg](/__cm__/asset/as_abc123)");
  });
});

describe("asset src 新旧形态双读", () => {
  it("新形态 /__cm__/asset/<id>", () => {
    expect(decodeAssetSrc("/__cm__/asset/as_abc123")).toBe("as_abc123");
  });
  it("旧形态 /__cm__asset:<id> 仍可读（历史版本不迁移）", () => {
    expect(decodeAssetSrc("/__cm__asset:as_abc123")).toBe("as_abc123");
  });
  it("非 asset 引用与普通 URL 返回 null", () => {
    expect(decodeAssetSrc("/__cm__/wiki/3fa85f64")).toBeNull();
    expect(decodeAssetSrc("https://example.com/a.png")).toBeNull();
  });
});
