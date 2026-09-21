/**
 * 字体片加载失败后自动重试（#594）。
 *
 * 剧本三个面按 unicode-range 切成 ~150 片（app/fonts.css），一页中文台词要命中
 * 几十片。弱网下某片超时 / 丢包，浏览器把那片的 FontFace 标成 `error`，那段码位
 * 的字就落回系统字体——而且**页面不刷新永远不再重试**，于是同一句话一半宋体
 * 一半黑体。
 *
 * CSS 声明的 FontFace 没有重试 API（`load()` 对 error 状态是空操作，`fonts.delete()`
 * 对 CSS 连接的面返回 false）。能做的是：从样式表里找回那条 @font-face 的 src，
 * 用同样的 family / weight / style / unicode-range `new FontFace(...)` 再加载一份、
 * `fonts.add()` 进去——同描述符的面后加的优先，且 error 的面在匹配时被跳过，
 * 新面就位即替换。url 追加 `&r=<次数>` 绕开对失败响应的任何内存缓存。
 *
 * 退避：baseDelay × 2^次数，最多 maxAttempts 次；同一片（按描述符）计一份账，
 * 用尽即放弃。重试成功会触发 loadingdone，useFontsSettled 的重测由此自然接上。
 */

type FontFaceLoadEvent = Event & { fontfaces?: readonly FontFace[] };

export type FontRetryOptions = {
  /** 每片最多重试次数，默认 3 */
  maxAttempts?: number;
  /** 首次重试延迟毫秒，之后翻倍，默认 1000 */
  baseDelayMs?: number;
  /** 从样式表找回 src；默认扫 document.styleSheets，测试可注入 */
  lookupSrc?: (face: FontFace) => string | null;
  /** 可注入的 FontFace 构造（jsdom 没有 FontFace） */
  createFace?: (family: string, src: string, descriptors: FontFaceDescriptors) => FontFace;
};

/** 同一片的身份：family 与四个描述符。引号 / 大小写按各浏览器规范化后一致，直接拼。 */
export function fontFaceKey(face: Pick<FontFace, "family" | "weight" | "style" | "unicodeRange">): string {
  return [stripQuotes(face.family), face.weight, face.style, face.unicodeRange].join("|");
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/**
 * 在文档所有可读样式表里找与 face 同 family / 描述符的 @font-face，返回其 src。
 * 跨域样式表读 cssRules 会抛 SecurityError——跳过（我们的 fonts.css 同源）。
 */
export function lookupFontFaceSrc(face: FontFace, doc: Document = document): string | null {
  const want = fontFaceKey(face);
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      const key = fontFaceKey({
        family: st.getPropertyValue("font-family").trim(),
        weight: st.getPropertyValue("font-weight").trim() || "normal",
        style: st.getPropertyValue("font-style").trim() || "normal",
        unicodeRange: st.getPropertyValue("unicode-range").trim() || "U+0-10FFFF",
      });
      if (key === want) return st.getPropertyValue("src").trim() || null;
    }
  }
  return null;
}

/** 给 src 里每个 url(...) 追加重试计数，绕开对失败响应的内存缓存 */
export function bustSrc(src: string, attempt: number): string {
  return src.replace(/url\((['"]?)([^'")]+)\1\)/g, (_m, q: string, u: string) => {
    const sep = u.includes("?") ? "&" : "?";
    return `url(${q}${u}${sep}r=${attempt}${q})`;
  });
}

/**
 * 挂到一个 FontFaceSet 上，返回卸载函数。
 */
export function installFontRetry(fonts: FontFaceSet, options: FontRetryOptions = {}): () => void {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const lookupSrc = options.lookupSrc ?? ((face: FontFace) => lookupFontFaceSrc(face));
  const createFace =
    options.createFace ??
    ((family: string, src: string, descriptors: FontFaceDescriptors) => new FontFace(family, src, descriptors));

  const attempts = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  const retry = (face: FontFace) => {
    const key = fontFaceKey(face);
    const n = attempts.get(key) ?? 0;
    if (n >= maxAttempts) return;
    const src = lookupSrc(face);
    if (!src) return;
    attempts.set(key, n + 1);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (disposed) return;
      const fresh = createFace(stripQuotes(face.family), bustSrc(src, n + 1), {
        weight: face.weight,
        style: face.style,
        unicodeRange: face.unicodeRange,
        display: face.display,
      });
      // 先 add 再 load：add 进集合后加载失败会再发 loadingerror，走同一条账；
      // 成功则 loadingdone，useFontsSettled 据此重测。
      fonts.add(fresh);
      fresh.load().catch(() => { /* 失败由 loadingerror 事件接手 */ });
    }, baseDelayMs * 2 ** n);
    timers.add(timer);
  };

  const onError = (event: Event) => {
    if (disposed) return;
    const failed = (event as FontFaceLoadEvent).fontfaces;
    const faces: FontFace[] = failed && failed.length > 0
      ? Array.from(failed)
      : Array.from(fonts as unknown as Iterable<FontFace>).filter((f) => f.status === "error");
    for (const face of faces) retry(face);
  };

  fonts.addEventListener("loadingerror", onError);
  return () => {
    disposed = true;
    fonts.removeEventListener("loadingerror", onError);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
