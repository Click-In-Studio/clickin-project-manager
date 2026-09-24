// wiki 行内样式方言（#524）——字色 / 底色 / 下划线，**HTML 子集**形态：
//
//   <span style="color:red">文字</span>
//   <span style="background-color:yellow">文字</span>
//   <u>文字</u>
//
// 为什么回落 HTML 而不是自造 `{fg=red}…{/}` 这类记号（方案评估见 #524）：
//   · 行内 HTML 是 CommonMark 标准构造，是 G1「寄生宿主」里最正统的一个；
//     Obsidian / Typora / Notion 导出都这么做，导出的 markdown 在外部工具里
//     真的显示颜色，自造记号在任何地方都只是字面符号。
//   · AI 天生会写，不用教就对；飞书粘贴来的就是 span style，只差吸附到色板。
//   · 上一轮 PR #379 借链接语法承载样式，正文一含 @提及就静默毁字——链接
//     不能嵌套，HTML 能。
//
// 代价是 HTML 拼法无数（`color: red;` / `<font>` / hex / rgb），所以本模块把
// canonical 钉死为**唯一拼法**：小写、无空格、无分号、双引号、颜色只收色名枚举。
// 归一化（canonicalizeInlineStyleTags）只认「能无损收成 canonical」的变体，
// 其余原样留着——保真锁会替用户把它显出来，绝不猜。
//
// 三条硬规矩（与 #525 高亮块同源）：
//   · 「默认颜色」不是色板里的一个值，是**没有这层标签**——unsetMark 去壳，
//     绝不写 `color:default`；「黑色」是真实枚举值 black。
//   · hex 只在 app/globals.css 的 `--text-fg-*` / `--text-bg-*` 定义一处，这里
//     只有名字；编辑器 renderHTML 与只读渲染都落 data-fg / data-bg 走同一套 CSS。
//   · 本文件零 node 依赖——客户端组件、remark 插件、AI 校验、保真锁四处共用。
//
// 只读端（lib/editor/remark-inline-style）、编辑器（lib/editor/tiptap-inline-style）、
// AI 说明书（lib/agent/tools/wiki-link-syntax）与本文件同批维护（语法大纲 G6）。

export const TEXT_FG_COLORS = ["black", "gray", "red", "orange", "yellow", "green", "blue", "purple"] as const;
export const TEXT_BG_COLORS = ["gray", "red", "orange", "yellow", "green", "blue", "purple"] as const;

export type TextFgColor = (typeof TEXT_FG_COLORS)[number];
export type TextBgColor = (typeof TEXT_BG_COLORS)[number];

export const TEXT_COLOR_LABELS: Record<TextFgColor, string> = {
  black: "黑", gray: "灰", red: "红", orange: "橙", yellow: "黄", green: "绿", blue: "蓝", purple: "紫",
};

export function isTextFgColor(v: unknown): v is TextFgColor {
  return typeof v === "string" && (TEXT_FG_COLORS as readonly string[]).includes(v);
}
export function isTextBgColor(v: unknown): v is TextBgColor {
  return typeof v === "string" && (TEXT_BG_COLORS as readonly string[]).includes(v);
}

// ── canonical 形态 ────────────────────────────────────────────────────────────

export function fgOpenTag(color: TextFgColor): string { return `<span style="color:${color}">`; }
export function bgOpenTag(color: TextBgColor): string { return `<span style="background-color:${color}">`; }
export const SPAN_CLOSE_TAG = "</span>";
export const U_OPEN_TAG = "<u>";
export const U_CLOSE_TAG = "</u>";

/** canonical 开标签 → 语义。不是三种 canonical 之一返回 null（含拼法变体）。 */
export function parseCanonicalOpenTag(tag: string): { kind: "fg"; color: TextFgColor } | { kind: "bg"; color: TextBgColor } | { kind: "u" } | null {
  if (tag === U_OPEN_TAG) return { kind: "u" };
  const m = /^<span style="(color|background-color):([a-z]+)">$/.exec(tag);
  if (!m) return null;
  if (m[1] === "color") return isTextFgColor(m[2]) ? { kind: "fg", color: m[2] } : null;
  return isTextBgColor(m[2]) ? { kind: "bg", color: m[2] } : null;
}

// ── 拼法归一化 ────────────────────────────────────────────────────────────────

/** 解析 style 串。只认 color / background(-color) 两个属性；出现任何别的属性、
 *  或颜色值不在枚举里，返回 null（= 不是本方言，别动）。 */
export function parseStyleColors(style: string): { fg: TextFgColor | null; bg: TextBgColor | null } | null {
  let fg: TextFgColor | null = null;
  let bg: TextBgColor | null = null;
  for (const decl of style.split(";")) {
    if (!decl.trim()) continue;
    const idx = decl.indexOf(":");
    if (idx < 0) return null;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim().toLowerCase();
    if (prop === "color") {
      if (!isTextFgColor(value) || fg) return null;
      fg = value;
    } else if (prop === "background-color" || prop === "background") {
      if (!isTextBgColor(value) || bg) return null;
      bg = value;
    } else {
      return null;
    }
  }
  return fg || bg ? { fg, bg } : null;
}

const SPAN_OPEN_RE = /<span\s+style\s*=\s*(["'])([^"']*)\1\s*>/gi;

/**
 * 把「能无损收成 canonical」的拼法变体收成 canonical；其余原样。幂等。
 *
 *   <span style="color: Red;">       → <span style="color:red">
 *   <span style='background: yellow'> → <span style="background-color:yellow">
 *   <U> / <u > / </U>                 → <u> / </u>
 *
 * 一个 span 同时写了字色和底色**不收**——canonical 是两层嵌套（底色在外），
 * 单个开标签改成两个就得配对改闭标签，字符串层做不可靠。这种正文进编辑器后
 * 会被解析成两个 mark 再序列化成两层，保真锁会响一次，用户在源码里看到差异
 * 即可；AI 写回路径由 wiki-dialect-check 直接拒绝。
 *
 * 调用方负责跳过代码段（dialect-migrate 有 protectCode；保真锁只对 html 节点调用）。
 */
export function canonicalizeInlineStyleTags(md: string): string {
  return md
    .replace(SPAN_OPEN_RE, (raw, _q, style: string) => {
      const parsed = parseStyleColors(style);
      if (!parsed) return raw;
      if (parsed.fg && parsed.bg) return raw;
      return parsed.fg ? fgOpenTag(parsed.fg) : bgOpenTag(parsed.bg!);
    })
    .replace(/<u\s*>/gi, U_OPEN_TAG)
    .replace(/<\/u\s*>/gi, U_CLOSE_TAG);
}

// ── 外来颜色吸附到色板（飞书粘贴用）──────────────────────────────────────────
//
// 不按 RGB 距离（淡色底对着饱和色名算距离会乱指），按色相分桶 + 饱和度 /
// 明度判灰与默认。桶边界按飞书实测色板校过：字色 #dc9b04 (h≈42) 落黄不落橙。

export type SnappedColor<T extends string> = T | "default" | null;

function parseCssColor(v: string): { r: number; g: number; b: number; a: number } | null {
  const t = v.trim().toLowerCase();
  if (!t) return null; // 没写颜色 ≠ 透明
  if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
  const hex = /^#([0-9a-f]{3,8})$/.exec(t);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map(c => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128],
    red: [255, 0, 0], orange: [255, 165, 0], yellow: [255, 255, 0], green: [0, 128, 0],
    blue: [0, 0, 255], purple: [128, 0, 128],
  };
  const c = named[t];
  return c ? { r: c[0], g: c[1], b: c[2], a: 1 } : null;
}

function hsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

function hueBucket(h: number): Exclude<TextBgColor, "gray"> {
  if (h < 15 || h >= 345) return "red";
  if (h < 40) return "orange";
  if (h < 70) return "yellow";
  if (h < 170) return "green";
  if (h < 260) return "blue";
  return "purple";
}

/**
 * 外来字色 → 色板名 / "default"（近黑 = 默认字色，不落 mark）/ null（解析不出来）。
 * 飞书默认字色 #1f2329 落 default——粘贴来的字极少是用户主动选的黑，按默认处理
 * 才不会把整篇正文都套上 black 标签。
 */
export function snapTextFg(css: string): SnappedColor<TextFgColor> {
  const c = parseCssColor(css);
  if (!c) return null;
  if (c.a === 0) return "default";
  const { h, s, l } = hsl(c.r, c.g, c.b);
  if (l < 0.22 && s < 0.25) return "default";
  if (s < 0.15) return l > 0.9 ? "default" : "gray";
  return hueBucket(h);
}

/** 外来底色 → 色板名 / "default"（透明或近白 = 无底色）/ null。 */
export function snapTextBg(css: string): SnappedColor<TextBgColor> {
  const c = parseCssColor(css);
  if (!c) return null;
  if (c.a === 0) return "default";
  const { h, s, l } = hsl(c.r, c.g, c.b);
  if (l > 0.97 && s < 0.25) return "default";
  if (s < 0.15) return "gray";
  return hueBucket(h);
}
