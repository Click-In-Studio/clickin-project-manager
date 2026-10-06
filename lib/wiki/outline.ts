// 零 Node 依赖：客户端从本地 markdown 实时生成文内目录。

export type WikiOutlineItem = {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  /** 标题在 markdown 中的字符位置，用于源码模式跳转。 */
  offset: number;
};

function visibleHeadingText(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1")
    .trim();
}

export function wikiHeadingAnchor(text: string): string {
  const slug = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `doc-heading-${slug || "section"}`;
}

/**
 * 只读取 ATX H1/H2/H3；围栏代码中的 # 不是标题。重复标题按文档顺序
 * 加 -2 / -3，保证每个跳转目标唯一。
 */
export function extractWikiOutline(markdown: string): WikiOutlineItem[] {
  const items: WikiOutlineItem[] = [];
  const counts = new Map<string, number>();
  let fencedBy: "`" | "~" | null = null;
  let offset = 0;

  for (const line of markdown.split(/\n/)) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (fencedBy === marker) fencedBy = null;
      else if (!fencedBy) fencedBy = marker;
      offset += line.length + 1;
      continue;
    }
    if (!fencedBy) {
      const match = /^\s{0,3}(#{1,3})[\t ]+(.+?)\s*$/.exec(line);
      if (match) {
        const text = visibleHeadingText(match[2].replace(/[\t ]+#+[\t ]*$/, ""));
        if (text) {
          const base = wikiHeadingAnchor(text);
          const count = (counts.get(base) ?? 0) + 1;
          counts.set(base, count);
          items.push({
            id: count === 1 ? base : `${base}-${count}`,
            level: match[1].length as 1 | 2 | 3,
            text,
            offset: offset + line.indexOf(match[2]),
          });
        }
      }
    }
    offset += line.length + 1;
  }
  return items;
}

export function activeWikiOutlineId(
  headings: Array<{ id: string; top: number }>,
  readingLine = 120,
): string | null {
  if (headings.length === 0) return null;
  let active = headings[0].id;
  for (const heading of headings) {
    if (heading.top > readingLine) break;
    active = heading.id;
  }
  return active;
}
