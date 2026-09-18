import { describe, it, expect } from "vitest";
import { buildSearchIndex, searchDocs, plainText } from "@/lib/help/search-index";

// 手册搜索（#538）：索引从真实内容建，打分纯函数可测。

const docs = buildSearchIndex();

describe("buildSearchIndex", () => {
  it("每篇一条，带面包屑、小节与纯文本正文", () => {
    expect(docs.length).toBeGreaterThan(30);
    const d = docs.find((x) => x.slug === "start/login/register-and-login")!;
    expect(d.crumbs).toBe("入门 › 注册与登录");
    expect(d.headings).toContain("怎么操作");
    expect(d.body).not.toMatch(/[#*`]|!\[/);
    expect(d.body.length).toBeLessThanOrEqual(4000);
  });
});

describe("plainText", () => {
  it("去掉围栏、图片、链接标记、callout 标记", () => {
    expect(plainText("## 标题\n\n看[这里](/x)和 ![图](/a.png)\n\n> [!💡]\n> 提示\n\n```\ncode\n```")).toBe("标题 看这里和 提示");
  });
});

describe("searchDocs", () => {
  it("标题命中排最前；多词 AND", () => {
    const r = searchDocs(docs, "cue 表");
    expect(r[0].doc.title).toMatch(/Cue 表/);
    expect(searchDocs(docs, "cue 不存在的词xyz")).toEqual([]);
  });
  it("正文命中给片段；空查询给空", () => {
    const r = searchDocs(docs, "席位已满");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].snippet).toContain("席位");
    expect(searchDocs(docs, "   ")).toEqual([]);
  });
  it("按剧组的说法也能找到：通告单 → Call Sheet 页", () => {
    const r = searchDocs(docs, "通告单");
    expect(r.map((x) => x.doc.slug)).toContain("production/events/publish-callsheet");
  });
});
