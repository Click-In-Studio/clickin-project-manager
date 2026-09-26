import { normalizeTableHtml } from "../editor/table-html";
import { transformRichTables, type MarkdownNode, type TableCell } from "../editor/table-dialect";
// 保真检测 —— 判断「用富文本打开再保存」会不会弄丢正文里的东西。
//
// ## 为什么不比字面
//
// 原先的做法是把「解析 → 再序列化」的结果和原文做字符串比较（只归一化了软
// 换行和行尾空白）。那会**大量误报**：实测下面这些一个都没丢内容，却全都触发
// 保真锁——
//
//     * 甲        →  - 甲          （列表符号）
//     __甲__      →  **甲**        （加粗写法）
//     _甲_        →  *甲*          （斜体写法）
//     甲\n===     →  # 甲          （setext 标题）
//     ~~~ ... ~~~ →  ``` ... ```   （代码围栏）
//     |a|b|       →  | a | b |     （表格补空格）
//     甲\n\n\n乙  →  甲\n\n乙       （多余空行）
//     [甲][a]     →  [甲](url)     （引用型链接转行内）
//
// 这些都是 markdown 的**书写风格**，序列化器有自己的 canonical 写法，跟内容
// 有没有丢毫无关系。按字面比，等于把"编辑器会把正文写成标准形态"当成事故。
//
// ## 比什么
//
// 真正要防的是**吃字**：正文里的东西经过一轮往返之后没了。所以比的是
// **内容签名**——用 remark 独立解析两侧（不经过 tiptap，否则 tiptap 丢掉的
// 东西两边会一起丢、比了等于没比），把所有"承载信息的值"收集起来：
//
//     文字 / 行内代码 / 代码块内容 / 裸 HTML 原文
//     链接与图片的 URL、图片的 alt、脚注标识
//
// URL 也收：链接文字还在但 href 没了，同样是损失，只看文字看不出来。
//
// 实测这套判据在上面那 8 种风格差异上全部安静，而对真损失照样报警：
//
//     甲[^1]\n\n[^1]: 注  →  甲[^1](%E6%B3%A8)   脚注被改坏
//     <div>甲</div>       →  甲                   HTML 标签丢失
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { REMARK_CJK_PLUGINS } from "../editor/remark-cjk-friendly";
import { canonicalizeInlineStyleTags } from "../editor/inline-style-dialect";
import { diffLines } from "diff";
import { parseCalloutMarker } from "../editor/tiptap-callout";

/** mdast 节点（只声明我们用得到的字段） */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  identifier?: string;
  lang?: string | null;
  children?: MdNode[];
};

/** 文字里的空白折叠成单个空格 —— 重新折行不算内容变化 */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 正文的**内容签名**：一串"承载信息的值"。
 *
 * 只走 remark，不经过 tiptap —— 用 tiptap 解析两侧的话，它丢掉的东西两边会
 * 一起丢，比较就永远相等，保真锁形同虚设。
 */
export function contentSignature(markdown: string): string[] {
  markdown = normalizeTableHtml(markdown);
  // CJK 侧翼规则与编辑器 / 只读侧同源（#674）：不挂的话 `甲**乙**丙` 两侧签名不一致
  const tree = unified().use(remarkParse).use(remarkGfm).use([...REMARK_CJK_PLUGINS]).parse(markdown) as unknown as MdNode;
  transformRichTables(tree as unknown as MarkdownNode, markdown);
  const out: string[] = [];

  const walk = (node: MdNode) => {
    if (node.type === "richTable" || node.type === "table") {
      out.push(`table:${JSON.stringify(tableSignature(node as unknown as MarkdownNode))}`);
      return;
    }
    switch (node.type) {
      case "text":
      case "inlineCode": {
        const v = collapse(node.value ?? "");
        if (v) out.push(v);
        break;
      }
      case "code":
        // 代码块内容**不折叠空白**：缩进就是内容
        if (node.value) out.push(`code:${node.lang ?? ""}:${node.value}`);
        break;
      case "html":
        // 裸 HTML 原样收。它掉了就是掉了——只读端还会把它当纯文本显示出来。
        // 行内样式方言（#524）的拼法变体先收成 canonical 再比：`color: red;` 与
        // 编辑器写出的 `color:red` 是同一个东西，不是失真
        if (node.value) out.push(`html:${collapse(canonicalizeInlineStyleTags(node.value))}`);
        break;
      case "image":
        out.push(`img:${node.url ?? ""}:${collapse(node.alt ?? "")}`);
        break;
      case "link":
      case "definition":
        // 链接文字还在但 href 没了，同样是损失——只看文字看不出来
        if (node.url) out.push(`url:${node.url}`);
        break;
      case "footnoteReference":
      case "footnoteDefinition":
        if (node.identifier) out.push(`fn:${node.identifier}`);
        break;
      default:
        break;
    }
    node.children?.forEach(walk);
  };

  walk(tree);
  return out;
}

/** 格子顺序与块结构参与比较，交换两格或丢跨度不能再被多重集掩盖。 */
function tableSignature(table: MarkdownNode): unknown {
  const clean = (node: MarkdownNode): unknown => {
    if (node.type === "richTable" || node.type === "table") return tableSignature(node);
    if (node.type === "blockquote") {
      const first = node.children?.[0];
      const text = first?.children?.[0];
      const callout = text?.type === "text" ? parseCalloutMarker(text.value ?? "") : null;
      if (callout) {
        const rest = (text!.value ?? "").slice(callout.length).replace(/^\n/, "");
        const inline = [...(rest ? [{ ...text!, value: rest }] : []), ...(first!.children?.slice(1) ?? [])];
        const blocks = [...(inline.length ? [{ ...first!, children: inline }] : []), ...(node.children?.slice(1) ?? [])];
        return { type: "callout", emoji: callout.emoji, color: callout.color, children: blocks.map(clean) };
      }
    }
    const out: Record<string, unknown> = { type: node.type };
    for (const key of ["value", "url", "alt", "lang", "depth", "ordered", "start", "checked"]) {
      const value = node[key];
      if (value != null) out[key] = key === "value" && node.type !== "code" && typeof value === "string" ? collapse(value) : value;
    }
    if (node.children) out.children = node.children.map(clean);
    return out;
  };
  return (table.children ?? []).map((row, i) => (row.children ?? []).map((cell, j) => {
    const attrs = cell.tableCell as TableCell | undefined;
    let content: MarkdownNode[] = attrs ? cell.children ?? [] : [{ type: "paragraph", children: cell.children }];
    // 一个空格的结构由 td/th 自身承载，空正文和唯一空段落等价；多个空段仍逐个比较。
    if (!content.length || (content.length === 1 && content[0].type === "paragraph"
      && content[0].children?.every(n => n.type === "text" && !collapse(n.value ?? "")))) {
      content = [{ type: "paragraph", children: [] }];
    }
    return {
      header: attrs?.header ?? i === 0,
      colspan: attrs?.colspan ?? 1, rowspan: attrs?.rowspan ?? 1,
      colwidth: attrs?.colwidth?.some(Boolean) ? attrs.colwidth : null,
      align: attrs?.align ?? (table.align as (string | null)[] | undefined)?.[j] ?? null,
      content: content.map(clean),
    };
  }));
}

export type FidelityDiff = {
  /** 有没有丢内容 */
  lossy: boolean;
  /** 丢了什么（原文有、往返后没有的那些签名项） */
  missing: string[];
  /** 多出了什么（往返后凭空出现的，通常意味着某个结构被改坏） */
  added: string[];
};

/**
 * 比较原文与「解析 → 再序列化」的结果。
 *
 * 用多重集比较而不是集合：同一个词出现三次变成一次也是丢内容。
 */
export function checkFidelity(body: string, roundTripped: string): FidelityDiff {
  const before = contentSignature(body);
  const after = contentSignature(roundTripped);

  const pool = new Map<string, number>();
  for (const k of after) pool.set(k, (pool.get(k) ?? 0) + 1);
  const missing: string[] = [];
  for (const k of before) {
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else missing.push(k);
  }
  const added: string[] = [];
  for (const [k, n] of pool) for (let i = 0; i < n; i++) added.push(k);

  return { lossy: missing.length > 0 || added.length > 0, missing, added };
}

/** 逐行差异，供提示里显示"到底哪儿不一样"（保真锁触发时不能只说"失真了"） */
export type DiffHunk = { kind: "added" | "removed"; text: string };

export function lineDiff(body: string, roundTripped: string, limit = 12): DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const part of diffLines(body, roundTripped)) {
    if (!part.added && !part.removed) continue;
    for (const line of part.value.split("\n")) {
      if (!line.trim()) continue;
      out.push({ kind: part.added ? "added" : "removed", text: line });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
