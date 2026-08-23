// wiki callout 方言 —— markdown 形态寄生在 blockquote 上：
//
//   > [!🍰|#fff5eb]
//   > 内容行…
//
// 首行 marker 携带 emoji（字面字符直接进 markdown，渲染端零映射表）与
// 背景色（hex，可省略 = 默认灰底）。寄生形态的理由（调研 §6.4）：
// 不认识该方言的渲染器/旧版编辑器把它显示成普通引用块，内容零丢失；
// blockquote 的 roundtrip 在 tiptap-markdown 里天然无损，不触发
// WikiDocClient 的保真锁。GitHub alerts 的 [!note] 写法也被同一 marker
// 正则接住（emoji 位落 "note" 字样），roundtrip 原样保留不做归一化——
// 归一化会改写原文，反而触发保真锁。
import { Node, mergeAttributes } from "@tiptap/core";

/** marker 正则：行首 [!<emoji>] 或 [!<emoji>|#hex]，emoji 位允许为空 */
export const CALLOUT_MARKER_RE = /^\[!([^|\]\n]*)(?:\|(#[0-9a-fA-F]{3,8}))?\]/;

export function formatCalloutMarker(emoji: string, color: string | null): string {
  return `[!${emoji}${color ? `|${color}` : ""}]`;
}

/**
 * markdown 解析侧：markdown-it 渲染出的 DOM 里，把「首段以 marker 开头的
 * blockquote」提升为 div[data-callout]（Callout.parseHTML 认这个形态）。
 * 供 tiptap-markdown 的 parse.updateDOM 钩子与单测使用。
 */
export function promoteCalloutBlockquotes(root: HTMLElement) {
  for (const bq of Array.from(root.querySelectorAll("blockquote"))) {
    const p = bq.querySelector(":scope > p");
    const first = p?.firstChild;
    if (!p || !first || first.nodeType !== 3 /* TEXT_NODE */) continue;
    const m = (first.textContent ?? "").match(CALLOUT_MARKER_RE);
    if (!m) continue;
    const doc = root.ownerDocument;
    // 剥掉 marker；marker 独占一行时连同其后的 <br> 一起剥
    first.textContent = (first.textContent ?? "").slice(m[0].length).replace(/^[ \t]*/, "");
    if (!first.textContent) {
      const next = first.nextSibling;
      first.remove();
      if (next && next.nodeName === "BR") next.remove();
    }
    if (!p.hasChildNodes()) p.remove();
    const div = doc.createElement("div");
    div.setAttribute("data-callout", "");
    div.setAttribute("data-emoji", m[1] ?? "");
    if (m[2]) div.setAttribute("data-color", m[2]);
    while (bq.firstChild) div.appendChild(bq.firstChild);
    if (!div.hasChildNodes()) div.appendChild(doc.createElement("p"));
    bq.replaceWith(div);
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      // emoji 存字面字符（[!] 空 emoji 也合法，roundtrip 原样保留）
      emoji: { default: "💡", parseHTML: (el: HTMLElement) => el.getAttribute("data-emoji") ?? "💡" },
      color: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-color") },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const color = node.attrs.color as string | null;
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-callout": "",
        "data-emoji": node.attrs.emoji ?? "",
        ...(color ? { "data-color": color, style: `--callout-bg:${color}` } : {}),
        class: "wiki-callout",
      }),
      0,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { wrapBlock: (d: string, f: string | null, n: unknown, fn: () => void) => void; write: (s: string) => void; ensureNewLine: () => void; renderContent: (n: unknown) => void },
          node: { attrs: { emoji?: string; color?: string | null } },
        ) {
          state.wrapBlock("> ", null, node, () => {
            state.write(formatCalloutMarker(node.attrs.emoji ?? "", node.attrs.color ?? null));
            state.ensureNewLine();
            state.renderContent(node);
          });
        },
        parse: {
          updateDOM(element: HTMLElement) {
            promoteCalloutBlockquotes(element);
          },
        },
      },
    };
  },
});
