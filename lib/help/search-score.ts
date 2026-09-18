// 手册搜索的纯函数（#538）：SearchDoc 形状、纯文本化、打分。**零 node 依赖**——
// 客户端 HelpSearch 直接 import 这里；带 fs 的 buildSearchIndex 在 search-index.ts。
// 客户端组件 import 到 lib/help/manual.ts（node:fs）会让 Turbopack 整站 500，不只是这一页。

/** 正文纯文本截断长度（索引体积闸） */
export const MAX_BODY = 4000;

export type SearchDoc = {
  slug: string;
  title: string;
  summary: string;
  /** 「入门 › 注册与登录」 */
  crumbs: string;
  headings: string[];
  /** 正文去掉 markdown 标记后的纯文本，截断到 MAX_BODY 字 */
  body: string;
};

/** 去掉 markdown 标记留纯文本：链接留文字、图片丢、代码围栏丢、表格竖线成空格。 */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s*\[![^\]]*\]\s*$/gm, " ")
    .replace(/[#>*_`|~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 客户端与测试共用的打分：标题命中最重，其次摘要 / 小节 / 面包屑，正文最轻；
 * 多个词全部要命中（AND），词序无关。返回按分数降序。
 */
export function searchDocs(docs: SearchDoc[], query: string, limit = 8): { doc: SearchDoc; snippet: string }[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: { doc: SearchDoc; score: number; snippet: string }[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const summary = doc.summary.toLowerCase();
    const heads = doc.headings.join(" ").toLowerCase();
    const crumbs = doc.crumbs.toLowerCase();
    const body = doc.body.toLowerCase();
    let score = 0;
    let ok = true;
    let firstBodyHit = -1;
    for (const t of terms) {
      let s = 0;
      if (title.includes(t)) s += 10;
      if (summary.includes(t)) s += 5;
      if (heads.includes(t)) s += 4;
      if (crumbs.includes(t)) s += 3;
      const bi = body.indexOf(t);
      if (bi >= 0) { s += 1; if (firstBodyHit < 0) firstBodyHit = bi; }
      if (s === 0) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    const snippet = firstBodyHit >= 0
      ? doc.body.slice(Math.max(0, firstBodyHit - 30), firstBodyHit + 70)
      : doc.summary;
    scored.push({ doc, score, snippet });
  }
  scored.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title, "zh"));
  return scored.slice(0, limit).map(({ doc, snippet }) => ({ doc, snippet }));
}
