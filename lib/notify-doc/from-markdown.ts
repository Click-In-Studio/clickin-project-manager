// 通知 variant 的 markdown renderer：markdown → NotifyDoc（平台接口 AST）。
//
// 与页面渲染器（WikiMarkdown）同源不同出口——两边吃的是同一份 markdown、同一套
// 四类方言，区别只在产物：页面产 React 节点、通知产平台无关 AST。
//
// 通知 variant 的两个特有约束：
//   1. **引用必须在服务端解析**。通知是在没有观看者会话的上下文里生成的，
//      走不了前端那条逐观看者 resolve，所以标签/URL 由注入的 RefResolver 给。
//   2. **URL 必须是绝对地址**。卡片在飞书客户端里点开，相对路径没有意义。
//
// 方言覆盖：引用类/嵌入类原生识别；布局类里 callout 降级成 quote、分栏降级成
// 顺序段落（通知场景没有并排布局的必要，也没有哪个通道支持）。
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { CM_HREF_PREFIX } from "../mention-types";
import { parseCalloutMarker } from "../tiptap-callout";
import { COLS_OPEN_RE, COLS_CLOSE_RE } from "../tiptap-columns";
import type { DocBlock, DocInline, NotifyDoc, RefResolver } from "./ast";

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  depth?: number;
  ordered?: boolean;
  lang?: string | null;
  children?: MdNode[];
};

const CM_RE = /^\/__cm__\/([a-z]+)\/([^/?#\s]+)(?:\?([^#\s]*))?(?:#.*)?$/;

/** 私有引用 URI → {type,id,params}；不是引用则 null。 */
function parseRef(url: string): { type: string; id: string; params: URLSearchParams } | null {
  if (!url.startsWith(CM_HREF_PREFIX)) return null;
  const m = url.match(CM_RE);
  if (!m) return null;
  return { type: m[1], id: decodeURIComponent(m[2]), params: new URLSearchParams(m[3] ?? "") };
}

async function inlines(
  nodes: MdNode[],
  resolve: RefResolver,
  marks: { bold?: boolean; italic?: boolean; code?: boolean } = {},
): Promise<DocInline[]> {
  const out: DocInline[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        if (n.value) out.push({ t: "text", text: n.value, ...marks });
        break;
      case "inlineCode":
        if (n.value) out.push({ t: "text", text: n.value, ...marks, code: true });
        break;
      case "strong":
        out.push(...await inlines(n.children ?? [], resolve, { ...marks, bold: true }));
        break;
      case "emphasis":
        out.push(...await inlines(n.children ?? [], resolve, { ...marks, italic: true }));
        break;
      case "delete":
        out.push(...await inlines(n.children ?? [], resolve, marks));
        break;
      case "break":
        out.push({ t: "br" });
        break;
      case "link": {
        const url = n.url ?? "";
        const ref = parseRef(url);
        const inner = await inlines(n.children ?? [], resolve, marks);
        const innerText = inner.map(i => (i.t === "text" || i.t === "link" ? i.text : i.t === "at" ? `@${i.name}` : "")).join("");
        if (!ref) {
          out.push({ t: "link", text: innerText || url, url });
          break;
        }
        const r = await resolve(ref);
        if (ref.type === "user") {
          // @提及：正文里 label 是保留的（姓名没有解析端点），resolve 不中就用它
          out.push({ t: "at", userId: ref.id, name: r?.label ?? (innerText.replace(/^@/, "") || "成员") });
          break;
        }
        if (!r) {
          // 解析不出来：给中性文字，绝不把裸 id 或私有 href 漏给用户
          out.push({ t: "text", text: innerText || "（引用）", ...marks });
          break;
        }
        if (r.url) out.push({ t: "link", text: r.label, url: r.url });
        else out.push({ t: "text", text: r.label, ...marks });
        break;
      }
      case "image": {
        // 行内图片在通知里降级成文字占位——块级 image 由 blocks() 单独处理
        out.push({ t: "text", text: n.alt ? `[图片：${n.alt}]` : "[图片]", ...marks });
        break;
      }
      default:
        if (n.children) out.push(...await inlines(n.children, resolve, marks));
        else if (n.value) out.push({ t: "text", text: n.value, ...marks });
    }
  }
  return out;
}

/** 段落文本（用于识别分栏 fence 这种"寄生在段落里的标记"） */
function paragraphText(n: MdNode): string | null {
  if (n.type !== "paragraph") return null;
  const kids = n.children ?? [];
  if (kids.length !== 1 || kids[0].type !== "text") return null;
  return kids[0].value ?? null;
}

async function blocks(nodes: MdNode[], resolve: RefResolver): Promise<DocBlock[]> {
  const out: DocBlock[] = [];
  for (const n of nodes) {
    // 分栏 fence 的标记段落整个丢弃（通知里没有并排布局，栏内容顺序铺开即可）
    const pt = paragraphText(n);
    if (pt != null && (COLS_OPEN_RE.test(pt) || COLS_CLOSE_RE.test(pt))) continue;

    switch (n.type) {
      case "paragraph": {
        // 段落里只有一张私有图片 → 块级 image
        const kids = n.children ?? [];
        if (kids.length === 1 && kids[0].type === "image") {
          const ref = parseRef(kids[0].url ?? "");
          if (ref?.type === "asset") {
            out.push({ t: "image", assetId: ref.id, alt: kids[0].alt ?? null });
            break;
          }
        }
        const ch = await inlines(kids, resolve);
        if (ch.length) out.push({ t: "p", children: ch });
        break;
      }
      case "heading":
        out.push({ t: "heading", level: n.depth ?? 1, children: await inlines(n.children ?? [], resolve) });
        break;
      case "blockquote": {
        // callout 寄生在 blockquote 上：剥掉 marker，emoji 并进首行文字
        const inner = await blocks(n.children ?? [], resolve);
        const first = inner[0];
        if (first?.t === "p" && first.children[0]?.t === "text") {
          const marker = parseCalloutMarker(first.children[0].text);
          if (marker) {
            const rest = first.children[0].text.slice(marker.length).replace(/^[ \t]*/, "");
            const kids = [...first.children];
            if (rest) {
              kids[0] = { ...first.children[0], text: rest };
            } else {
              // marker 独占一行：连同 remark-breaks 生成的换行一起剥，否则 emoji
              // 和正文之间会多出一个空行（页面渲染器 splitCalloutChildren 同款处理）
              kids.shift();
              if (kids[0]?.t === "br") kids.shift();
            }
            if (marker.emoji) kids.unshift({ t: "text", text: `${marker.emoji} ` });
            first.children = kids;
          }
        }
        const flat: DocInline[] = [];
        for (const b of inner) {
          if (flat.length) flat.push({ t: "br" });
          if (b.t === "p" || b.t === "heading" || b.t === "quote") flat.push(...b.children);
          else if (b.t === "code") flat.push({ t: "text", text: b.text, code: true });
        }
        if (flat.length) out.push({ t: "quote", children: flat });
        break;
      }
      case "list": {
        const items: DocInline[][] = [];
        for (const li of n.children ?? []) {
          const sub = await blocks(li.children ?? [], resolve);
          const flat: DocInline[] = [];
          for (const b of sub) {
            if (b.t === "p" || b.t === "heading" || b.t === "quote") flat.push(...b.children);
            else if (b.t === "list") for (const it of b.items) flat.push(...it);
          }
          if (flat.length) items.push(flat);
        }
        if (items.length) out.push({ t: "list", ordered: n.ordered === true, items });
        break;
      }
      case "code":
        out.push({ t: "code", lang: n.lang ?? null, text: n.value ?? "" });
        break;
      case "thematicBreak":
        out.push({ t: "divider" });
        break;
      case "table": {
        // 通知里不铺表格：逐行拍成段落，单元格用 " · " 连接（不吃内容）
        for (const row of n.children ?? []) {
          const cells: DocInline[] = [];
          for (const cell of row.children ?? []) {
            if (cells.length) cells.push({ t: "text", text: " · " });
            cells.push(...await inlines(cell.children ?? [], resolve));
          }
          if (cells.length) out.push({ t: "p", children: cells });
        }
        break;
      }
      default:
        if (n.children) out.push(...await blocks(n.children, resolve));
    }
  }
  return out;
}

/** markdown → 平台无关 AST。resolve 负责把 id 引用换成实时标签 + 绝对 URL。 */
export async function renderNotifyDoc(md: string, resolve: RefResolver): Promise<NotifyDoc> {
  if (!md.trim()) return { blocks: [] };
  // 必须 parse + runSync 两步：remark-breaks 是纯 transformer（把 text 里的 \n
  // 转成 break 节点），只调 .parse() 它根本不会跑——换行会留在 text 里，
  // callout 的 marker 剥不干净、行内换行也丢失结构。remark-gfm 则两阶段都有，
  // 表格靠的是它的 parser 扩展，所以只 parse 时表格看着是好的，更容易漏掉。
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks);
  const tree = processor.runSync(processor.parse(md)) as unknown as MdNode;
  return { blocks: await blocks(tree.children ?? [], resolve) };
}
