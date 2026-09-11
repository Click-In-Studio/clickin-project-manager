// @vitest-environment jsdom
// 保真检测。
//
// 这份测试的两半同等重要：
//   · **不该报的别报** —— 书写风格的归一化（列表符号、加粗写法、表格补空格…）
//     一个都不许触发。误报比漏报更伤：用户被无缘无故踢回源码模式，久了就不再
//     相信这个提示，真出事时也当没看见。
//   · **该报的必须报** —— 吃字、结构被改坏、href 丢失。
//
// 下面这些 (原文 → 往返结果) 全是拿真实扩展集实测出来的，不是编的。
import { describe, it, expect } from "vitest";
import { contentSignature, checkFidelity, lineDiff } from "@/lib/wiki/fidelity";

/** 实测的书写风格归一化：内容零丢失，保真锁必须安静 */
const STYLE_ONLY: [string, string, string][] = [
  ["列表符号", "* 甲\n* 乙", "- 甲\n- 乙"],
  ["加粗写法", "__甲__", "**甲**"],
  ["斜体写法", "_甲_", "*甲*"],
  ["setext 标题", "甲\n===", "# 甲"],
  ["代码围栏", "~~~\n甲\n~~~", "```\n甲\n```"],
  ["表格补空格", "|a|b|\n|-|-|\n|1|2|", "| a | b |\n| --- | --- |\n| 1 | 2 |\n"],
  ["任务列表空行", "- [ ] 甲\n- [x] 乙", "- [ ] 甲\n\n- [x] 乙"],
  ["多余空行折叠", "甲\n\n\n乙", "甲\n\n乙"],
  ["引用型链接转行内", "[甲][a]\n\n[a]: https://x.com", "[甲](https://x.com)"],
  ["段落重新折行", "甲乙\n丙丁", "甲乙 丙丁"],
];

describe("书写风格归一化不该触发", () => {
  it.each(STYLE_ONLY)("%s", (_name, before, after) => {
    const r = checkFidelity(before, after);
    expect({ missing: r.missing, added: r.added, lossy: r.lossy })
      .toEqual({ missing: [], added: [], lossy: false });
  });
});

describe("真丢内容必须触发", () => {
  // 实测：脚注被序列化成一个 URL 编码过的链接，定义整个没了
  it("脚注被改坏", () => {
    const r = checkFidelity("甲[^1]\n\n[^1]: 注", "甲[^1](%E6%B3%A8)");
    expect(r.lossy).toBe(true);
    expect(r.missing.join()).toContain("fn:1");
  });

  it("裸 HTML 标签丢失", () => {
    const r = checkFidelity("<div>甲</div>", "甲");
    expect(r.lossy).toBe(true);
    expect(r.missing.some(m => m.startsWith("html:"))).toBe(true);
  });

  it("整段文字没了", () => {
    const r = checkFidelity("甲\n\n乙\n\n丙", "甲\n\n丙");
    expect(r.lossy).toBe(true);
    expect(r.missing).toContain("乙");
  });

  // 只看文字看不出来的那一类
  it("链接文字还在但 href 没了", () => {
    const r = checkFidelity("[甲](https://x.com)", "甲");
    expect(r.lossy).toBe(true);
    expect(r.missing).toContain("url:https://x.com");
  });

  it("图片没了（alt 与 src 都算内容）", () => {
    const r = checkFidelity("![说明](/__cm__/asset/abc)", "");
    expect(r.lossy).toBe(true);
    expect(r.missing).toContain("img:/__cm__/asset/abc:说明");
  });

  it("代码块的缩进被吃掉 —— 代码里空白就是内容，不折叠", () => {
    const r = checkFidelity("```\n  甲\n```", "```\n甲\n```");
    expect(r.lossy).toBe(true);
  });

  it("重复出现的词少了一次也算丢（多重集比较，不是集合）", () => {
    const r = checkFidelity("甲\n\n甲\n\n甲", "甲\n\n甲");
    expect(r.lossy).toBe(true);
    expect(r.missing).toEqual(["甲"]);
  });

  it("凭空多出来的内容也报 —— 多半意味着某个结构被改坏了", () => {
    const r = checkFidelity("甲", "甲\n\n乙");
    expect(r.lossy).toBe(true);
    expect(r.added).toContain("乙");
  });
});

describe("contentSignature", () => {
  it("只收承载信息的值，不收语法标记", () => {
    expect(contentSignature("**甲** 和 *乙*")).toEqual(["甲", "和", "乙"]);
  });

  it("行内代码算内容", () => {
    expect(contentSignature("`x = 1`")).toEqual(["x = 1"]);
  });

  it("方言形态（引用/图片）按 URL 记账", () => {
    // 显示位那个固定哨兵 `#` 也会被当文字收进来。两侧都有，不会造成误报，
    // 而且它在就说明这条引用还在——无害
    expect(contentSignature("[#](/__cm__/wiki/abc)")).toEqual(["url:/__cm__/wiki/abc", "#"]);
  });

  it("空正文给空签名", () => {
    expect(contentSignature("")).toEqual([]);
    expect(contentSignature("\n\n  \n")).toEqual([]);
  });
});

describe("lineDiff（触发时要能看见差在哪）", () => {
  it("给出增删的行", () => {
    const hunks = lineDiff("甲\n乙\n丙", "甲\n丁\n丙");
    expect(hunks.some(h => h.kind === "removed" && h.text.includes("乙"))).toBe(true);
    expect(hunks.some(h => h.kind === "added" && h.text.includes("丁"))).toBe(true);
  });

  it("完全相同则没有差异行", () => {
    expect(lineDiff("甲\n乙", "甲\n乙")).toEqual([]);
  });

  it("差异很多时按 limit 截断（提示框里不能刷屏）", () => {
    const a = Array.from({ length: 50 }, (_, i) => `第${i}行`).join("\n");
    const b = Array.from({ length: 50 }, (_, i) => `另${i}行`).join("\n");
    expect(lineDiff(a, b, 6)).toHaveLength(6);
  });
});
