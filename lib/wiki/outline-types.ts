// 零 Node 依赖：客户端从本地 markdown 实时生成文内目录。

export type WikiOutlineItem = {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  /** 标题正文在 markdown 中的字符范围，用于源码模式跳转。 */
  offset: number;
  endOffset: number;
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
  const usedIds = new Set<string>();
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let offset = 0;

  for (const line of markdown.split(/\n/)) {
    const fenceLine = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceLine && (!fence || (
      fenceLine[1][0] === fence.marker
      && fenceLine[1].length >= fence.length
      && fenceLine[2].trim() === ""
    ))) {
      if (fence) fence = null;
      else fence = {
        marker: fenceLine[1][0] as "`" | "~",
        length: fenceLine[1].length,
      };
      offset += line.length + 1;
      continue;
    }
    if (!fence) {
      const match = /^\s{0,3}(#{1,3})[\t ]+(.+?)\s*$/.exec(line);
      if (match) {
        const rawHeading = match[2].replace(/[\t ]+#+[\t ]*$/, "");
        const text = visibleHeadingText(rawHeading);
        if (text) {
          const base = wikiHeadingAnchor(text);
          let count = (counts.get(base) ?? 0) + 1;
          let id = count === 1 ? base : `${base}-${count}`;
          while (usedIds.has(id)) {
            count += 1;
            id = `${base}-${count}`;
          }
          const headingOffset = offset + line.indexOf(match[2]);
          counts.set(base, count);
          usedIds.add(id);
          items.push({
            id,
            level: match[1].length as 1 | 2 | 3,
            text,
            offset: headingOffset,
            endOffset: headingOffset + rawHeading.length,
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
