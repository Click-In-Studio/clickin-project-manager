/**
 * 剧本正文的行内 markdown → HTML。
 * 编辑器与打印页共用——两边必须同一份实现，否则屏上与纸上不一致。
 */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stagePairRegex(delimOpen = "（", delimClose = "）"): RegExp {
  return new RegExp(
    `${escapeRegex(delimOpen)}[^${escapeRegex(delimClose)}\n]*${escapeRegex(delimClose)}`,
    "g"
  );
}

export function mdToHtml(md: string, delimOpen?: string, delimClose?: string): string {
  let s = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (delimOpen !== undefined && delimClose !== undefined) {
    const pairRegex = stagePairRegex(delimOpen, delimClose);
    s = s.replace(pairRegex, (match) =>
      `<span data-stage-inline="" style="font-family:var(--font-stage);font-style:italic;color:#a1a1aa">${match}</span>`
    );
  }
  // Collapse 3+ consecutive * or _ to exactly 2, so nested markers from old
  // double-bold bugs render as a single level instead of mis-parsing.
  s = s.replace(/\*{3,}/g, "**").replace(/_{3,}/g, "__");
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, (_, inner) => `<b>${inner}</b>`);
  s = s.replace(/__([\s\S]+?)__/g, (_, inner) => `<u>${inner}</u>`);
  s = s.replace(/\n/g, "<br>");
  return s;
}
