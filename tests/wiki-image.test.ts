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

/** 模块级往返（内层 describe 里那个同名函数够不着这里） */
function rt(md: string): string {
  const editor = makeEditor(md);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (editor.storage as any).markdown.getMarkdown() as string;
  editor.destroy();
  return out;
}

describe("图片是块级节点：不能把后面的段落并进来", () => {
  // 内建的 image serializer 是给**行内**图片写的，只 write 不 closeBlock。
  // 本节点是 block，用内建那个会得到 `![说明](x)乙`——两段并成一段。
  // 文字一个没少，所以保真锁（比的是内容签名）也发现不了，属于静默改结构
  it("图片与后一段之间保留段落分隔", () => {
    const md = "甲\n\n![说明](/__cm__/asset/abc)\n\n乙";
    expect(rt(md)).toBe(md);
  });

  it("图片与前一段之间也保留", () => {
    const md = "甲\n\n![](/__cm__/asset/abc)";
    expect(rt(md)).toBe(md);
  });

  it("连续两张图片各自成块", () => {
    const md = "![一](/__cm__/asset/a)\n\n![二](/__cm__/asset/b)";
    expect(rt(md)).toBe(md);
  });

  it("alt 里的方括号被转义，不破坏 markdown 结构", () => {
    const out = rt("![a [b] c](/__cm__/asset/abc)");
    // 结构与 URL 必须完好：转义没做对的话 `]` 会提前闭合，整条语法就散了
    expect(out).toMatch(/^!\[.*\]\(\/__cm__\/asset\/abc\)$/);
    // 已知局限（既有行为，非本轮引入）：alt 里的方括号在**二次**解析时会丢，
    // markdown-it 对转义方括号的 alt 处理如此。内容主体（URL）不受影响
  });
});

describe("图片节点全站注册（不再按 imageUpload 门控）", () => {
  // 「一切文本皆文档」之后所有面都存 markdown。不认识 image 节点 = schema
  // 直接把图片吃掉，而非 wiki 的面还没有保真锁兜底，属于静默丢内容
  function withoutImageExt(md: string): string {
    const e = new Editor({
      extensions: [StarterKit, Markdown.configure({ breaks: true })],
      content: md,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (e.storage as any).markdown.getMarkdown() as string;
    e.destroy();
    return out;
  }

  // 反证：没有这个扩展，图片连同它那一段整个消失
  it("反证 —— 缺了 image 扩展，图片整段被吃掉", () => {
    const md = "甲\n\n![说明](/__cm__/asset/abc)\n\n乙";
    expect(withoutImageExt(md)).toBe("甲\n\n乙");
  });

  it("装上之后逐字复原", () => {
    const md = "甲\n\n![说明](/__cm__/asset/abc)\n\n乙";
    expect(rt(md)).toBe(md);
  });
});
