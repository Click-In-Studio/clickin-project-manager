// 手册客户端搜索（#538）的索引：服务端从 loadManual 抽一份轻量 JSON，浏览器一次拉取、
// 本地过滤。不做后端检索——几十页、每页几 KB，前端 includes 足够，而且手册是公开页，
// 不想给未登录流量开一个查询接口。

import { loadManual, type Manual } from "./manual";

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

const MAX_BODY = 4000;

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

export function buildSearchIndex(manual: Manual = loadManual()): SearchDoc[] {
  const out: SearchDoc[] = [];
  for (const sec of manual.sections) {
    for (const grp of sec.groups) {
      for (const p of grp.pages) {
        out.push({
          slug: p.slug,
          title: p.title,
          summary: p.summary ?? "",
          crumbs: `${sec.title} › ${grp.title}`,
          headings: p.headings.map((h) => h.text),
          body: plainText(p.body).slice(0, MAX_BODY),
        });
      }
    }
  }
  return out;
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
