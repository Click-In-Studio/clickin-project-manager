// @vitest-environment jsdom
/**
 * installFontRetry（#594）的行为守卫。
 *
 * 钉的是：
 *   · loadingerror 带来的每个失败面，都按同 family / 描述符重建一份、加进集合并加载，
 *     url 带重试计数（绕开失败响应的内存缓存）
 *   · 同一片按描述符记账：退避翻倍、到 maxAttempts 即放弃，重建的面再失败也算同一份账
 *   · 样式表里找不到 src 的面不重试（不是我们的字体）
 *   · 事件不带 fontfaces 时退化为扫集合里 status === "error" 的面
 *   · 卸载后清掉待发的定时器
 * jsdom 没有 FontFace / FontFaceSet，用最小假实现驱动；lookupSrc / createFace 注入。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installFontRetry, bustSrc, fontFaceKey } from "@/components/print/font-retry";

type Status = "unloaded" | "loading" | "loaded" | "error";

class FakeFace {
  status: Status = "unloaded";
  loadImpl: () => Promise<FakeFace> = () => Promise.resolve(this);
  constructor(
    public family: string,
    public src: string,
    public weight = "400",
    public style = "normal",
    public unicodeRange = "U+0-10FFFF",
    public display = "swap",
  ) {}
  load() { return this.loadImpl(); }
}

class FakeFontFaceSet extends EventTarget {
  faces: FakeFace[] = [];
  add(f: FakeFace) { this.faces.push(f); return this; }
  [Symbol.iterator]() { return this.faces[Symbol.iterator](); }
  fail(faces: FakeFace[]) {
    for (const f of faces) f.status = "error";
    const ev = new Event("loadingerror") as Event & { fontfaces: FakeFace[] };
    ev.fontfaces = faces;
    this.dispatchEvent(ev);
  }
}

const SRC = "url(\"/fonts/shs-medium/4e00.woff2?v=abcd1234\") format(\"woff2\")";

function setup(opts: { maxAttempts?: number; srcFor?: (f: FakeFace) => string | null } = {}) {
  const fonts = new FakeFontFaceSet();
  const created: FakeFace[] = [];
  const dispose = installFontRetry(fonts as unknown as FontFaceSet, {
    maxAttempts: opts.maxAttempts ?? 3,
    baseDelayMs: 100,
    lookupSrc: (f) => (opts.srcFor ?? (() => SRC))(f as unknown as FakeFace),
    createFace: (family, src, d) => {
      const f = new FakeFace(family, src, String(d.weight), String(d.style), String(d.unicodeRange), String(d.display));
      created.push(f);
      return f as unknown as FontFace;
    },
  });
  return { fonts, created, dispose };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("bustSrc / fontFaceKey", () => {
  it("给每个 url() 追加 r=<次数>，已有 query 用 &", () => {
    expect(bustSrc(SRC, 2)).toBe("url(\"/fonts/shs-medium/4e00.woff2?v=abcd1234&r=2\") format(\"woff2\")");
    expect(bustSrc("url(/a.woff2)", 1)).toBe("url(/a.woff2?r=1)");
  });
  it("family 引号、大小写、多余空白不影响身份；描述符不同则不同", () => {
    const base = fontFaceKey({ family: "SourceHanSerif", weight: "400 600", style: "normal", unicodeRange: "U+4E00-51FF" });
    expect(fontFaceKey({ family: "\"SourceHanSerif\"", weight: "400 600", style: "normal", unicodeRange: "U+4E00-51FF" })).toBe(base);
    expect(fontFaceKey({ family: "SourceHanSerif", weight: " 400   600 ", style: "Normal", unicodeRange: "u+4e00-51ff" })).toBe(base);
    expect(fontFaceKey({ family: "SourceHanSerif", weight: "700 900", style: "normal", unicodeRange: "U+4E00-51FF" })).not.toBe(base);
    expect(fontFaceKey({ family: "SourceHanSerif", weight: "400 600", style: "normal", unicodeRange: "U+5200-55FF" })).not.toBe(base);
  });
});

describe("installFontRetry", () => {
  it("失败面 → 退避后按同描述符重建、加入集合并加载，url 带重试计数", () => {
    const { fonts, created } = setup();
    const face = new FakeFace("SourceHanSerif", "", "400 600", "normal", "U+4E00-51FF");
    fonts.fail([face]);
    expect(created).toHaveLength(0);
    vi.advanceTimersByTime(99);
    expect(created).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(created).toHaveLength(1);
    expect(created[0].family).toBe("SourceHanSerif");
    expect(created[0].weight).toBe("400 600");
    expect(created[0].unicodeRange).toBe("U+4E00-51FF");
    // 整串比对：重试计数必须由样式表原始 src 重新推导，不能在上一轮已 bust 的 url 上再叠
    expect(created[0].src).toBe("url(\"/fonts/shs-medium/4e00.woff2?v=abcd1234&r=1\") format(\"woff2\")");
    expect(fonts.faces).toContain(created[0]);
  });

  it("同一片记同一份账：退避翻倍，到 maxAttempts 放弃（重建面再失败也算）", () => {
    const { fonts, created } = setup({ maxAttempts: 3 });
    const face = new FakeFace("SourceHanSerif", "", "400 600", "normal", "U+4E00-51FF");
    fonts.fail([face]);
    vi.advanceTimersByTime(100);
    expect(created).toHaveLength(1);
    fonts.fail([created[0]]);            // 重建的那份也失败
    vi.advanceTimersByTime(199);
    expect(created).toHaveLength(1);
    vi.advanceTimersByTime(1);           // 200ms
    expect(created).toHaveLength(2);
    expect(created[1].src).toBe("url(\"/fonts/shs-medium/4e00.woff2?v=abcd1234&r=2\") format(\"woff2\")");
    fonts.fail([created[1]]);
    vi.advanceTimersByTime(400);
    expect(created).toHaveLength(3);
    expect(created[2].src).toBe("url(\"/fonts/shs-medium/4e00.woff2?v=abcd1234&r=3\") format(\"woff2\")");
    fonts.fail([created[2]]);            // 第 4 次：放弃
    vi.advanceTimersByTime(10_000);
    expect(created).toHaveLength(3);
  });

  it("不同片各记各的账", () => {
    const { fonts, created } = setup();
    const a = new FakeFace("SourceHanSerif", "", "400 600", "normal", "U+4E00-51FF");
    const b = new FakeFace("SourceHanSerif", "", "400 600", "normal", "U+5200-55FF");
    fonts.fail([a, b]);
    vi.advanceTimersByTime(100);
    expect(created.map((f) => f.unicodeRange).sort()).toEqual(["U+4E00-51FF", "U+5200-55FF"]);
  });

  it("样式表里找不到 src 的面不重试", () => {
    const { fonts, created } = setup({ srcFor: () => null });
    fonts.fail([new FakeFace("Geist", "")]);
    vi.advanceTimersByTime(10_000);
    expect(created).toHaveLength(0);
  });

  it("事件不带 fontfaces → 扫集合里 status === error 的面", () => {
    const { fonts, created } = setup();
    const bad = new FakeFace("SourceHanSerif", "", "400 600", "normal", "U+4E00-51FF");
    bad.status = "error";
    const ok = new FakeFace("SourceHanSerif", "", "400 600", "normal", "U+5200-55FF");
    ok.status = "loaded";
    fonts.add(bad); fonts.add(ok);
    fonts.dispatchEvent(new Event("loadingerror"));
    vi.advanceTimersByTime(100);
    expect(created.map((f) => f.unicodeRange)).toEqual(["U+4E00-51FF"]);
  });

  it("卸载后待发的重试作废，之后的失败也不再理会", () => {
    const { fonts, created, dispose } = setup();
    fonts.fail([new FakeFace("SourceHanSerif", "", "400 600", "normal", "U+4E00-51FF")]);
    dispose();
    vi.advanceTimersByTime(1000);
    fonts.fail([new FakeFace("SourceHanSerif", "", "400 600", "normal", "U+5200-55FF")]);
    vi.advanceTimersByTime(1000);
    expect(created).toHaveLength(0);
  });
});
