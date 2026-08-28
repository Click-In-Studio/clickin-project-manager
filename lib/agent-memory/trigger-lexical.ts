// CJK bigram 词法分词（零依赖）。原生长在 index-db.ts，#333 P2 把它抽出来：
// lib/mcp/tool-catalog.ts 的工具召回要用同一把尺子，但不该为此把 pg 依赖树
// 拉进自己的静态依赖图（本仓库有过 Turbopack 循环依赖 TDZ 前科）。
// index-db.ts 原地再导出，既有调用方（trigger.ts / 索引器）零改动。

// 汉字（基本区+扩展A）+ 日文假名 + 谚文音节
const CJK_RUN = /[一-鿿㐀-䶿぀-ヿ가-힯]+/gu;
const ASCII_RUN = /[a-z0-9]+/g;

export function bigramTokens(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(CJK_RUN)) {
    const run = [...m[0]];
    if (run.length === 1) tokens.push(run[0]);
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run[i] + run[i + 1]);
  }
  for (const m of lower.matchAll(ASCII_RUN)) tokens.push(m[0]);
  return tokens;
}
