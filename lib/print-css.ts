/**
 * 打印页的 `@page` 声明——**所有纸张尺寸只在这一个文件里出现**。
 *
 * 起因：原先 `globals.css` 硬编码 `@page { size: A4 portrait }`，而演出可选四种
 * 版式，letter / 双排版式打出来纸张对不上（#335）。纸张尺寸散落就一定会漂，
 * 所以集中到这里，两种形态放在一起互相看得见。
 */
import type { PageConfig } from "./script-page";

/**
 * 有版式概念的打印页（剧本）：纸张尺寸必须由**页盒尺寸**算出来。
 *
 * 用 px 而不是 `A4 portrait` 这类关键字，是因为页盒本身就是 px 的
 * （`lib/script-page.ts` 的 96dpi 常量），纸张与页盒必须逐点对齐，
 * 换成关键字就等于让浏览器再做一次映射，把好不容易钉死的一致性交出去。
 *
 * 注意用 `cfg.width` 而非 `cfg.width × cfg.cols`：`cols` 目前是死字段，
 * 没有任何地方消费它，双排版式实际渲染的仍是单栏页盒。等真做了双栏排版
 * （#338/#343）再连这里一起改。
 */
export function printPageCss(cfg: PageConfig): string {
  return `@page { size: ${cfg.width}px ${cfg.height}px; margin: 0; }`;
}

/**
 * 无版式概念的打印页（wiki 等）：直接声明纸张关键字。
 *
 * 这里**故意**不走 `printPageCss(PAGE_CONFIGS.a4)`。wiki 没有页盒——它是一条流，
 * 由浏览器自己断页——所以没有"要对齐的像素"，用关键字让浏览器按打印机的真实
 * A4 走反而更稳（不依赖 96dpi 假设，也没有取整误差）。
 *
 * 两种形态放在同一个文件里，就是为了让下一个改纸张逻辑的人一眼看见它们的分工，
 * 而不是在别处再写第三份字面量。
 */
export const PRINT_PAGE_CSS_A4 = "@page { size: A4 portrait; margin: 0; }";

/** 页边距恒为 0：页边距由页盒 / 内容自己带，不交给 `@page`。 */
export const PRINT_PAGE_MARGIN_CSS = "margin: 0";
