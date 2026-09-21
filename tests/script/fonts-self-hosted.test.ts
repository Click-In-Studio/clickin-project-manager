/**
 * 剧本字体自托管（#336 B3）的结构性守卫。
 *
 * 这些断言钉的是「三个面都自托管且覆盖完整」这个前提——它错了，跨平台分页一致
 * 就无从谈起，而错法都是静默的（某个面悄悄落回系统字体，只有换行点变了）。
 *   · app/fonts.css 里的每一片文件都真实存在（生成物与文件不脱节）
 *   · 每片 url 的 ?v= 等于文件内容 sha256 前 8 位（#594：/fonts/ 一年 immutable，
 *     版本戳说谎 = 重切后用户永远拿旧片）
 *   · 三个 CSS 变量的**首选**家族都有 @font-face（首选面不能是系统字体）
 *   · 每个家族的 unicode-range 并集覆盖 CJK 统一表意文字、CJK 标点、全角形式
 *   · manifest 与 CSS 一致（同一个生成器的两份产物）
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import path from "path";

const ROOT = process.cwd();
const css = readFileSync(path.join(ROOT, "app/fonts.css"), "utf8");
const globals = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "public/fonts/manifest.json"), "utf8")) as {
  faces: Record<string, { css_family: string; chunks: Array<{ file: string; range: string; sha256: string }> }>;
};

/** src 是不带 query 的文件路径；version 是 url 上的 ?v= */
type Face = { family: string; src: string; version: string; weight: string; range: [number, number] };

function parseFaces(): Face[] {
  const faces: Face[] = [];
  for (const block of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const body = block[1];
    const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
    const url = /url\('([^']+)'\)/.exec(body)?.[1];
    const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1];
    const range = /unicode-range:\s*U\+([0-9A-F]+)-([0-9A-F]+)/i.exec(body);
    expect(family && url && weight && range, `@font-face 缺字段：${body}`).toBeTruthy();
    const [src, query] = url!.split("?");
    const version = /^v=([0-9a-f]{8})$/.exec(query ?? "")?.[1];
    expect(version, `${url} 缺 ?v=<sha256 前 8 位>`).toBeTruthy();
    faces.push({ family: family!, src, version: version!, weight: weight!.trim(), range: [parseInt(range![1], 16), parseInt(range![2], 16)] });
  }
  return faces;
}

const faces = parseFaces();

function covers(family: string, from: number, to: number): boolean {
  const ranges = faces.filter(f => f.family === family).map(f => f.range).sort((a, b) => a[0] - b[0]);
  let cursor = from;
  for (const [a, b] of ranges) {
    if (b < cursor) continue;
    if (a > cursor) return false;
    cursor = b + 1;
    if (cursor > to) return true;
  }
  return cursor > to;
}

function firstFamily(cssVar: string): string {
  const m = new RegExp(`${cssVar}:\\s*'([^']+)'`).exec(globals);
  expect(m, `${cssVar} 未定义`).toBeTruthy();
  return m![1];
}

describe("字体片文件与 CSS 一致", () => {
  it("fonts.css 非空，每一片的文件都存在且非空", () => {
    expect(faces.length).toBeGreaterThan(50);
    for (const face of faces) {
      const file = path.join(ROOT, "public", face.src);
      expect(existsSync(file), `缺文件 ${face.src}`).toBe(true);
      expect(statSync(file).size, `${face.src} 为空`).toBeGreaterThan(0);
    }
  });

  it("每片 url 的 ?v= 等于文件内容 sha256 前 8 位（缓存一年 immutable 的前提）", () => {
    for (const face of faces) {
      const digest = createHash("sha256").update(readFileSync(path.join(ROOT, "public", face.src))).digest("hex");
      expect(face.version, `${face.src} 的 ?v= 与文件内容不符——重切后没重生成 fonts.css？`).toBe(digest.slice(0, 8));
    }
  });

  it("manifest 里的片与 fonts.css 一一对应（路径 + 版本）", () => {
    const fromCss = new Set(faces.map(f => `${f.src}?v=${f.version}`));
    const fromManifest = new Set(
      Object.entries(manifest.faces).flatMap(([out, face]) => face.chunks.map(c => `/fonts/${out}/${c.file}?v=${c.sha256.slice(0, 8)}`)),
    );
    expect([...fromManifest].sort()).toEqual([...fromCss].sort());
  });
});

describe("三个面的首选家族都是自托管的", () => {
  const families = new Set(faces.map(f => f.family));
  for (const cssVar of ["--font-script", "--font-stage", "--font-lyric"]) {
    it(`${cssVar} 的首选家族有 @font-face`, () => {
      expect(families.has(firstFamily(cssVar)), `${cssVar} 的首选家族不是自托管面`).toBe(true);
    });
  }

  it("缺字兜底先落到自托管的 SourceHanSerif，再到系统字体（跨平台一致的前提）", () => {
    for (const cssVar of ["--font-stage", "--font-lyric"]) {
      const stack = new RegExp(`${cssVar}:\\s*([^;]+);`).exec(globals)![1];
      const names = [...stack.matchAll(/'([^']+)'/g)].map(m => m[1]);
      expect(names[1], `${cssVar} 的第二顺位应是 SourceHanSerif`).toBe("SourceHanSerif");
    }
  });
});

describe("每个家族的 unicode-range 覆盖剧本需要的区间", () => {
  const families = [...new Set(faces.map(f => f.family))];
  for (const family of families) {
    it(`${family}：CJK 统一表意文字 U+4E00-9FFF`, () => {
      expect(covers(family, 0x4e00, 0x9fff)).toBe(true);
    });
    it(`${family}：CJK 标点 U+3000-303F 与全角形式 U+FF00-FFEF`, () => {
      expect(covers(family, 0x3000, 0x303f)).toBe(true);
      expect(covers(family, 0xff00, 0xffef)).toBe(true);
    });
    it(`${family}：基本拉丁 U+0020-007E`, () => {
      expect(covers(family, 0x20, 0x7e)).toBe(true);
    });
  }

  it("SourceHanSerif 两个字重区间不重叠且合起来覆盖 400-900", () => {
    const weights = [...new Set(faces.filter(f => f.family === "SourceHanSerif").map(f => f.weight))].sort();
    expect(weights).toEqual(["400 600", "700 900"]);
  });
});
