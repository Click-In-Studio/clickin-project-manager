import { describe, it, expect } from "vitest";
import { escapeRegex, mdToHtml, stagePairRegex } from "@/lib/script-md";

/**
 * 行内 markdown → HTML 的护栏（#335 抽出为共用件时补）。
 *
 * 编辑器与打印页共用这一份实现。它同时是**注入面**（正文是用户输入）和
 * **排版面**（行内舞台指示的 span 会影响块高，进而影响分页），两边都不能漂。
 */
describe("mdToHtml", () => {
  it("先转义再解析——尖括号不能变成标签", () => {
    expect(mdToHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(mdToHtml("a & b")).toBe("a &amp; b");
  });

  it("** → <b>，__ → <u>", () => {
    expect(mdToHtml("**粗**与__下__")).toBe("<b>粗</b>与<u>下</u>");
  });

  it("三个以上的 * / _ 收敛成两个——旧的重复加粗 bug 留下的正文不能崩", () => {
    // 注释里写明：collapse 3+ so nested markers from old double-bold bugs
    // render as a single level instead of mis-parsing
    expect(mdToHtml("***粗***")).toBe("<b>粗</b>");
    expect(mdToHtml("****粗****")).toBe("<b>粗</b>");
    expect(mdToHtml("___下___")).toBe("<u>下</u>");
  });

  it("换行变 <br>", () => {
    expect(mdToHtml("上\n下")).toBe("上<br>下");
  });

  it("给了定界符才包行内舞台指示，且带 data-stage-inline", () => {
    const withDelim = mdToHtml("他说（小声）算了", "（", "）");
    expect(withDelim).toContain('data-stage-inline=""');
    expect(withDelim).toContain("（小声）");
    // 不给定界符就不包——否则任何括号都会被当成舞台指示
    expect(mdToHtml("他说（小声）算了")).not.toContain("data-stage-inline");
  });

  it("舞台指示不跨行匹配——跨行的括号不该被吞成一大段", () => {
    const out = mdToHtml("（上\n下）", "（", "）");
    expect(out).not.toContain("data-stage-inline");
  });

  it("自定义定界符生效", () => {
    expect(mdToHtml("他说[小声]算了", "[", "]")).toContain("data-stage-inline");
  });
});

describe("stagePairRegex / escapeRegex", () => {
  it("定界符里的正则元字符被转义，不会变成通配", () => {
    expect(escapeRegex("(")).toBe("\\(");
    // 若不转义，`(` 会让 RegExp 构造抛错或改变语义
    expect(() => stagePairRegex("(", ")")).not.toThrow();
    expect("他说(小声)算了".match(stagePairRegex("(", ")"))).toEqual(["(小声)"]);
  });

  it("默认定界符是中文括号", () => {
    expect("他说（小声）算了".match(stagePairRegex())).toEqual(["（小声）"]);
  });
});
