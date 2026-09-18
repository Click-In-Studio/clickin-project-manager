// 手册客户端搜索（#538）的索引：服务端从 loadManual 抽一份轻量 JSON，浏览器一次拉取、
// 本地过滤。不做后端检索——几十页、每页几 KB，前端 includes 足够，而且手册是公开页，
// 不想给未登录流量开一个查询接口。纯函数（打分 / 纯文本化）在 search-score.ts，
// 这个文件带 fs，只能在服务端 import。

import { loadManual, type Manual } from "./manual";
import { plainText, MAX_BODY, type SearchDoc } from "./search-score";

export { searchDocs, plainText, type SearchDoc } from "./search-score";

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
