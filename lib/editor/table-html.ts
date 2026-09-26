// 历史 HTML 表格的只读输入适配。标准 HTML parser + 白名单节点转 Markdown；
// 不支持的结构保留原文交给保真锁，不执行任意 HTML，也不写数据库。
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import type { Root } from "mdast";
import { TABLE_MARKER_RE, parseMarkdownTree, parseCellOptions, serializeRichTable, tableGrid, type MarkdownNode, type RichTable, type TableCell } from "./table-dialect";
import { encodeMentionHref, decodeMentionHref, type ContentMentionAttrs } from "./mention-types";
import { canonicalizeInlineStyleTags, parseCanonicalOpenTag } from "./inline-style-dialect";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
const element = (n: HtmlNode): n is HtmlElement => "tagName" in n;
const attrs = (n: HtmlElement) => Object.fromEntries(n.attrs.map(a => [a.name, a.value]));
const children = (n: HtmlNode): HtmlNode[] => "childNodes" in n ? n.childNodes : [];
const text = (n: HtmlNode): string => n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value : children(n).map(text).join("");
const paragraph = (kids: MarkdownNode[]): MarkdownNode => ({ type: "paragraph", children: kids });
const raw = (value: string): MarkdownNode => ({ type: "html", value });
const INLINE = new Set(["text", "strong", "emphasis", "delete", "inlineCode", "link", "image", "break"]);
function onlyAttributes(node: HtmlElement, allowed: string[]) {
  if (node.attrs.some(a => !allowed.includes(a.name))) throw new Error("未支持的表格属性");
}

function styleProperties(style = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const declaration of style.split(";")) {
    if (!declaration.trim()) continue;
    const parts = declaration.split(":");
    if (parts.length !== 2) throw new Error("未支持的样式");
    result[parts[0].trim().toLowerCase()] = parts[1].trim();
  }
  return result;
}

function blocks(nodes: MarkdownNode[]): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  let pending: MarkdownNode[] = [];
  const flush = () => {
    if (pending.some(n => n.type !== "text" || n.value?.trim())) out.push(paragraph(pending));
    pending = [];
  };
  for (const n of nodes) {
    if (INLINE.has(n.type) || (n.type === "html" && /^<\/?(span|u)\b/.test(n.value ?? ""))) pending.push(n);
    else { flush(); out.push(n); }
  }
  flush();
  return out;
}

function write(nodes: MarkdownNode[]): string {
  const protect = (node: MarkdownNode) => {
    const only = node.children?.[0];
    if (node.type === "paragraph" && node.children?.length === 1 && only?.type === "text" && TABLE_MARKER_RE.test(only.value ?? "")) {
      node.children = [raw("\\" + only.value)];
    } else node.children?.forEach(protect);
  };
  nodes.forEach(protect);
  return toMarkdown({ type: "root", children: blocks(nodes) } as unknown as Root, {
    bullet: "-", emphasis: "*", fences: true, extensions: [gfmToMarkdown()],
  }).trimEnd();
}

function convert(n: HtmlNode): MarkdownNode[] {
  if (n.nodeName === "#text") return [{ type: "text", value: text(n).replace(/[\t\r\n ]+/g, " ") }];
  if (!element(n)) {
    if (n.nodeName === "#comment") throw new Error("含未支持的注释");
    return [];
  }
  const a = attrs(n);
  if (Object.keys(a).some(k => /^on/i.test(k))) throw new Error("含事件属性");
  const tag = n.tagName;
  if (tag === "table") return [raw(serializeRichTable(convertTable(n)))];
  if (a.style && !["span", "div"].includes(tag)) throw new Error("无法保留的块或图片样式");
  if (tag === "img") {
    if (a.width || a.height) throw new Error("图片尺寸尚不能无损保存");
    const src = a["data-cm-src"] || a.src;
    if (!src) throw new Error("图片没有地址");
    return [{ type: "image", url: src, alt: a.alt || "", title: a.title || null }];
  }
  if (tag === "pre") {
    const code = children(n).find(c => element(c) && c.tagName === "code");
    const language = code && element(code) ? /(?:^|\s)language-([^\s]+)/.exec(attrs(code).class ?? "")?.[1] : null;
    return [{ type: "code", lang: language || null, value: text(code || n) }];
  }
  if (tag === "code") return [{ type: "inlineCode", value: text(n) }];
  if (tag === "br") return [{ type: "break" }];
  if (tag === "hr") return [{ type: "thematicBreak" }];
  if (tag === "span" && a["data-content-mention"]) {
    const ref: ContentMentionAttrs = {
      kind: (a["data-kind"] || a.kind || "wiki") as ContentMentionAttrs["kind"],
      id: a["data-id"] || a["data-content-mention"],
      displayMode: (a["data-display-mode"] || null) as ContentMentionAttrs["displayMode"],
      aux: a["data-aux"] || null, versionId: a["data-version-id"] || null,
    };
    const url = encodeMentionHref(ref);
    if (!decodeMentionHref(url)) throw new Error("无法识别引用");
    return [{ type: "link", url, children: [{ type: "text", value: "#" }] }];
  }
  if (tag === "span" && a["data-type"] === "atMention") {
    if (!a["data-id"]) throw new Error("成员引用缺少 id");
    return [{ type: "link", url: `/__cm__/user/${encodeURIComponent(a["data-id"])}`, children: [{ type: "text", value: text(n) }] }];
  }
  const kids = children(n).flatMap(convert);
  if (tag === "p") return kids.length ? [paragraph(kids)] : [raw("&nbsp;")];
  if (/^h[1-6]$/.test(tag)) return [{ type: "heading", depth: Number(tag[1]), children: kids }];
  const mark = ({ strong: "strong", b: "strong", em: "emphasis", i: "emphasis", s: "delete", del: "delete" } as Record<string, string>)[tag];
  if (mark) return [{ type: mark, children: kids }];
  if (tag === "a") return [{ type: "link", url: a.href || "", title: a.title || null, children: kids }];
  if (tag === "ul" || tag === "ol") return [{ type: "list", ordered: tag === "ol", start: Number(a.start) || 1, spread: false, children: kids }];
  if (tag === "li") return [{ type: "listItem", spread: false, checked: a["data-type"] === "taskItem" ? a["data-checked"] === "true" : null, children: blocks(kids) }];
  if (tag === "blockquote") return [{ type: "blockquote", children: blocks(kids) }];
  if (tag === "u") return [raw("<u>"), ...kids, raw("</u>")];
  if (tag === "span") {
    if (!a.style && !a["data-fg"] && !a["data-bg"]) return kids;
    const style = a.style || (a["data-fg"] ? `color:${a["data-fg"]}` : `background-color:${a["data-bg"]}`);
    const open = canonicalizeInlineStyleTags(`<span style="${style.replace(/"/g, "&quot;")}">`);
    if (!parseCanonicalOpenTag(open)) throw new Error("未支持的文字样式");
    return [raw(open), ...kids, raw("</span>")];
  }
  if (tag === "div" && "data-callout" in a) {
    const marker = `[!${a["data-emoji"] || "💡"}${a["data-color"] ? ` bg=${a["data-color"]}` : ""}]`;
    return [{ type: "blockquote", children: [paragraph([raw(marker)]), ...blocks(kids)] }];
  }
  if (tag === "div" && "data-cols" in a) {
    const cols = children(n).filter(element);
    if (cols.some(c => !("data-col" in attrs(c)))) throw new Error("无法识别分栏");
    const ratios = cols.map(c => Number(attrs(c)["data-ratio"]));
    const head = ratios.every(v => v > 0) ? `:::cols ${ratios.join(",")}` : ":::cols";
    return [raw([head, cols.map(c => write(children(c).flatMap(convert))).join("\n\n---\n\n"), ":::"].join("\n\n"))];
  }
  if (tag === "div" && "data-col" in a) return blocks(kids);
  if (tag === "div" && !a.style) return blocks(kids);
  throw new Error(`未支持的 ${tag}`);
}

function convertTable(table: HtmlElement): RichTable {
  // parse5 会修复省略闭合的 HTML；存储适配不能据此猜测原本的格边界。
  const validate = (n: HtmlNode) => {
    if (n.nodeName === "#comment") throw new Error("含未支持的注释");
    if (element(n) && ["table", "tr", "td", "th"].includes(n.tagName) && !n.sourceCodeLocation?.endTag) throw new Error("表格标签未完整闭合");
    children(n).forEach(validate);
  };
  validate(table);
  onlyAttributes(table, ["class", "style"]);
  const layout = styleProperties(attrs(table).style);
  if (Object.keys(layout).some(k => !["width", "min-width"].includes(k))) throw new Error("未支持的表格布局");
  const cols = children(table).filter(n => element(n) && n.tagName === "colgroup").flatMap(children).filter(element);
  const widths = cols.map(col => {
    onlyAttributes(col, ["class", "style", "width", "span"]);
    const a = attrs(col);
    if (Object.keys(styleProperties(a.style)).some(k => k !== "width")) throw new Error("未支持的列样式");
    if (a.span && a.span !== "1") throw new Error("未支持的列组跨度");
    const value = a.width || /(?:^|;)\s*width\s*:\s*([^;]+)/.exec(a.style || "")?.[1]?.trim();
    if (!value) return 0;
    if (!/^\d+(?:px)?$/.test(value)) throw new Error("未支持的列宽单位");
    return Number(value.replace(/px$/, ""));
  });
  const rowElements = children(table).flatMap(n => element(n) && ["thead", "tbody", "tfoot"].includes(n.tagName) ? children(n) : [n]);
  const rows: TableCell[][] = [];
  for (const row of rowElements) {
    if (!element(row)) { if (text(row).trim()) throw new Error("表格内有游离内容"); continue; }
    if (row.tagName === "colgroup") continue;
    if (row.tagName !== "tr") throw new Error("未支持的表格结构");
    onlyAttributes(row, ["class"]);
    const cells: TableCell[] = [];
    for (const c of children(row)) {
      if (!element(c)) { if (text(c).trim()) throw new Error("行内有游离内容"); continue; }
      if (c.tagName !== "td" && c.tagName !== "th") throw new Error("未支持的格结构");
      onlyAttributes(c, ["class", "style", "colspan", "rowspan", "colwidth", "align"]);
      const a = attrs(c);
      const styles = styleProperties(a.style);
      if (Object.keys(styles).some(k => k !== "text-align")) throw new Error("未支持的单元格样式");
      const align = a.align || /(?:^|;)\s*text-align\s*:\s*(left|center|right)/.exec(a.style || "")?.[1];
      const options = [c.tagName === "th" ? "header=true" : "", a.colspan ? `colspan=${a.colspan}` : "", a.rowspan ? `rowspan=${a.rowspan}` : "", a.colwidth ? `colwidth=${a.colwidth}` : "", align ? `align=${align}` : ""].filter(Boolean).join(" ");
      const cell = parseCellOptions(options);
      if (!cell) throw new Error("非法单元格属性");
      cells.push({ ...cell, body: write(children(c).flatMap(convert)) });
    }
    rows.push(cells);
  }
  const result = { rows };
  const grid = tableGrid(result);
  if (!grid || (widths.length && widths.length !== grid.width)) throw new Error("非法表格网格");
  // 列组宽度仅在单元格未携带宽度时补入；按逻辑列跳过跨行占位。
  const occupied: boolean[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    let x = 0;
    row.forEach(cell => {
      while (occupied[r][x]) x++;
      if (cell.colwidth?.some((w, i) => w && widths[x + i] && w !== widths[x + i])) throw new Error("列组与单元格宽度冲突");
      const w = Array.from({ length: cell.colspan }, (_, i) => cell.colwidth?.[i] || widths[x + i] || 0);
      if (w.some(Boolean)) cell.colwidth = w;
      for (let y = r; y < r + cell.rowspan; y++) for (let c = x; c < x + cell.colspan; c++) occupied[y][c] = true;
      x += cell.colspan;
    });
  });
  const finalGrid = tableGrid(result);
  if (!finalGrid) throw new Error("列宽不一致");
  for (const [kind, value] of Object.entries(layout)) {
    const expected = finalGrid.columns.reduce((sum, w) => sum + (w || 25), 0);
    if (!/^\d+px$/.test(value) || Number(value.slice(0, -2)) !== expected || (kind === "width" && finalGrid.columns.some(w => !w))) throw new Error("表宽不是列宽的派生值");
  }
  return result;
}

/** 只转换完整独立 HTML 表格；未知结构返回 null，不根据浏览器修复猜内容。 */
export function htmlTableToMarkdown(html: string): string | null {
  if (!/^\s*<table\b/i.test(html) || !/<\/table>\s*$/i.test(html)) return null;
  try {
    const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
    const nodes = fragment.childNodes.filter(n => element(n) || text(n).trim());
    if (nodes.length !== 1 || !element(nodes[0]) || nodes[0].tagName !== "table") return null;
    return serializeRichTable(convertTable(nodes[0]));
  } catch { return null; }
}

/** 定点替换 HTML AST 节点，代码示例与其余正文保持字节不变。 */
export function normalizeTableHtml(source: string): string {
  if (!/<table\b/i.test(source)) return source;
  const edits: { start: number; end: number; text: string }[] = [];
  const walk = (node: MarkdownNode) => {
    if (node.type === "html" && node.value) {
      const converted = htmlTableToMarkdown(node.value);
      if (converted != null && node.position?.start.offset != null && node.position.end.offset != null) {
        const start = node.position.start.offset;
        const prefix = source.slice(source.lastIndexOf("\n", start - 1) + 1, start)
          .replace(/(?:[-+*]|\d+[.)])([ \t]+)$/, match => " ".repeat(match.length));
        edits.push({ start, end: node.position.end.offset, text: converted.replace(/\n/g, "\n" + prefix) });
      }
    }
    node.children?.forEach(walk);
  };
  walk(parseMarkdownTree(source));
  let result = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, e.start) + e.text + result.slice(e.end);
  return result;
}
