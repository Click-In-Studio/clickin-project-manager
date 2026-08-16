import { describe, it, expect } from "vitest";
import { normalizeLegacyMentions } from "@/lib/mention-format";

// 存量/损坏 mention 归一化（PR #247）：旧形态与被旧 round-trip bug 转义毁掉的
// 残骸 → 可 round-trip 的链接形态；正常内容零改动

const B = "\\";

describe("normalizeLegacyMentions", () => {
  it("legacy plain @[name](uid:x) → [@name](uid:x)", () => {
    expect(normalizeLegacyMentions("@[王恺镔](uid:78f2a083-986b)"))
      .toBe("[@王恺镔](uid:78f2a083-986b)");
  });

  it("escaped bracket wreckage (single and full)", () => {
    expect(normalizeLegacyMentions(`@${B}[王恺镔${B}](uid:78f2a083)`))
      .toBe("[@王恺镔](uid:78f2a083)");
    expect(normalizeLegacyMentions(`@${B}[王恺镔${B}]${B}(uid:78f2a083${B})`))
      .toBe("[@王恺镔](uid:78f2a083)");
  });

  it("multi-escaped wreckage (double round-trip damage)", () => {
    expect(normalizeLegacyMentions(`@${B}${B}[王恺镔${B}${B}](uid:78f2a083)`))
      .toBe("[@王恺镔](uid:78f2a083)");
  });

  it("escaped cm link restored", () => {
    expect(normalizeLegacyMentions(`${B}[#标题${B}](/__cm__wiki:abc-123)`))
      .toBe("[#标题](/__cm__wiki:abc-123)");
  });

  it("healthy content untouched", () => {
    const healthy = [
      "[@王恺镔](uid:78f2a083)",
      "[#标题](/__cm__wiki:abc-123)",
      "正常 [链接](https://a.com) 与 **粗体**",
    ].join("\n");
    expect(normalizeLegacyMentions(healthy)).toBe(healthy);
  });
});
