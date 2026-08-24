// @vitest-environment jsdom
// 渲染前置处理的回归护栏。
// 背景：preprocessRawWikilinks 与 normalizeWikiDialect 各有一套 NUL 占位保护，
// 曾经因为调用顺序颠倒（先占位再调归一化），归一化的 restoreCode 拿自己的空
// parts "还原"了外层占位符 —— 正文里每段代码块都被替换成空串。
import { describe, it, expect } from "vitest";
import { preprocessRawWikilinks } from "@/components/wiki/WikiMarkdown";

describe("preprocessRawWikilinks", () => {
  it("代码块原样保留（嵌套占位符回归）", () => {
    const md = "说明：\n\n```ts\nconst a = 1;\n```\n\n行内 `foo()` 也在。";
    expect(preprocessRawWikilinks(md).text).toBe(md);
  });

  it("代码块里的 [[标题]] 是语法示例，不升格、不计入标题清单", () => {
    const { text, titles } = preprocessRawWikilinks("`[[示例]]`\n\n```\n[[另一个]]\n```");
    expect(titles).toEqual([]);
    expect(text).toContain("[[示例]]");
    expect(text).toContain("[[另一个]]");
  });

  it("正文里的 [[标题]] 转成待解析链接并计入清单", () => {
    const { text, titles } = preprocessRawWikilinks("见 [[世界观报告]]");
    expect(titles).toEqual(["世界观报告"]);
    expect(text).toContain("/__wt__");
  });

  it("同一篇里代码块与真双链并存，互不干扰", () => {
    const { text, titles } = preprocessRawWikilinks("见 [[真链接]]\n\n```\n[[假的]]\n```");
    expect(titles).toEqual(["真链接"]);
    expect(text).toContain("```\n[[假的]]\n```");
  });

  it("顺带完成 v1 方言归一化（历史版本渲染）", () => {
    const { text } = preprocessRawWikilinks("[@张三](uid:u_1)");
    expect(text).toBe("[@张三](/__cm__/user/u_1)");
  });
});
