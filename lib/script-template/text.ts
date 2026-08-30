/**
 * 估算器用的纯文本工具。从 lib/script-page.ts 原样搬来——行数估算的口径
 * （CJK 1 单位、其余 0.5、每行 floor(宽/字号) 单位）是存量页码的一部分，不能改。
 */

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const CJK_RE = /[⺀-⿿　-鿿豈-﫿︰-﹏]/;

/** 估算一段文字在每行 upl 个全角单位下占几行；空文本算 1 行（渲染时占位「　」） */
export function estimateLines(text: string, upl: number): number {
  if (!text.trim()) return 1;
  let total = 0;
  for (const paragraph of text.split("\n")) {
    let units = 0;
    let lineCount = 1;
    for (const ch of paragraph) {
      const isCJK = CJK_RE.test(ch);
      units += isCJK ? 1 : 0.5;
      if (units > upl) {
        lineCount++;
        units = isCJK ? 1 : 0.5;
      }
    }
    total += lineCount;
  }
  return total || 1;
}

/** 一段文字占多少全角单位（inline 前缀扣首行宽度用） */
export function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += CJK_RE.test(ch) ? 1 : 0.5;
  return units;
}
