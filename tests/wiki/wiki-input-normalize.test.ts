// 输入态 → 存储态：源码模式手写的 [[标题]] 升格（语法大纲 §6.4/§6.5）。
// 富文本模式的 [[ 走 picker 直接插存储态，到不了这条路径；AI 恒写存储态。
import { describe, it, expect } from "vitest";
import { collectWikilinkTitles, promoteWikilinks } from "@/lib/wiki/input-normalize";

const map = new Map([["世界观报告", "3fa85f64-5717-4562-b3fc-2c963f66afa6"]]);

describe("collectWikilinkTitles", () => {
  it("去重 + 去空白", () => {
    expect(collectWikilinkTitles("[[A]] 与 [[ A ]] 还有 [[B]]")).toEqual(["A", "B"]);
  });
  it("码内的 [[ ]] 是语法示例，不算", () => {
    expect(collectWikilinkTitles("`[[A]]`\n\n```\n[[B]]\n```")).toEqual([]);
  });
});

describe("promoteWikilinks", () => {
  it("命中标题 → 升格成存储态引用", () => {
    expect(promoteWikilinks("见 [[世界观报告]] 一节", map))
      .toBe("见 [#](/__cm__/wiki/3fa85f64-5717-4562-b3fc-2c963f66afa6) 一节");
  });

  it("未命中 → 原样留着（幻影语义，绝不猜）", () => {
    const md = "见 [[还没建的文档]] 一节";
    expect(promoteWikilinks(md, map)).toBe(md);
  });

  it("同一篇里命中与未命中并存，各走各的", () => {
    expect(promoteWikilinks("[[世界观报告]] 和 [[未知]]", map))
      .toBe("[#](/__cm__/wiki/3fa85f64-5717-4562-b3fc-2c963f66afa6) 和 [[未知]]");
  });

  it("码内不改写", () => {
    const md = "示例：`[[世界观报告]]`";
    expect(promoteWikilinks(md, map)).toBe(md);
  });

  it("空表 = 全部留作幻影（取不到文档清单时不动正文）", () => {
    const md = "[[世界观报告]]";
    expect(promoteWikilinks(md, new Map())).toBe(md);
  });

  it("已是存储态的引用不受影响", () => {
    const md = "[#](/__cm__/wiki/3fa85f64-5717-4562-b3fc-2c963f66afa6)";
    expect(promoteWikilinks(md, map)).toBe(md);
  });
});
