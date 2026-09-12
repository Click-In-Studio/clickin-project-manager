// 平台 renderer：NotifyDoc → 飞书卡片 element 数组。
//
// 飞书的富文本能力是 `lark_md`（粗体/斜体/删除线/行内码/链接/<at>），**没有**标题、
// 表格、块引用、块级代码。所以这里做的是「能富就富、富不了就降级成排版约定」：
//   heading  → 粗体独占一行
//   quote    → 每行前缀 "▏"（lark_md 无引用块，用字符模拟，不吃字）
//   list     → "• " / "1. " 前缀
//   code     → 独立 div + 行内码包裹（lark_md 的 ``` 支持不稳定）
//   divider  → 卡片原生 {tag:"hr"}
//   image    → 需要 img_key（上传后才有），这里降级成文字占位
//
// 降级一律遵守 G5：形态可以丢，字不能丢。
import type { DocBlock, DocInline, NotifyDoc } from "./ast";

/** lark_md 的元字符：转义后才不会把用户正文里的星号当成加粗标记 */
function esc(s: string): string {
  return s.replace(/([*_~`\[\]])/g, "\\$1");
}

export type FeishuRenderOptions = {
  /** 内部 userId → 飞书 open_id。缺失的成员降级成 `@姓名` 纯文字。 */
  openIdByUserId?: Map<string, string>;
  /** 站内相对路径 → 该通道可达的绝对地址（通常传 adapter.buildActionUrl） */
  buildUrl?: (path: string) => string;
};

function inline(nodes: DocInline[], opts: FeishuRenderOptions): string {
  return nodes.map(n => {
    switch (n.t) {
      case "br": return "\n";
      case "at": {
        const openId = opts.openIdByUserId?.get(n.userId);
        return openId ? `<at id=${openId}></at>` : `@${esc(n.name)}`;
      }
      case "link": {
        const url = n.url.startsWith("/") && opts.buildUrl ? opts.buildUrl(n.url) : n.url;
        return `[${esc(n.text)}](${url})`;
      }
      case "text": {
        let s = esc(n.text);
        if (n.code) s = `\`${n.text}\``; // 行内码内部不转义——码里就该是字面量
        if (n.bold) s = `**${s}**`;
        if (n.italic) s = `*${s}*`;
        return s;
      }
    }
  }).join("");
}

function blockToLines(b: DocBlock, opts: FeishuRenderOptions): string | null {
  switch (b.t) {
    case "p": return inline(b.children, opts);
    case "heading": return `**${inline(b.children, opts)}**`;
    case "quote": return inline(b.children, opts).split("\n").map(l => `▏${l}`).join("\n");
    case "list":
      return b.items
        .map((it, i) => `${b.ordered ? `${i + 1}. ` : "• "}${inline(it, opts)}`)
        .join("\n");
    case "code": return `\`${b.text.replace(/\n/g, "\n")}\``;
    case "image": return b.alt ? `[图片：${b.alt}]` : "[图片]";
    case "divider": return null; // 由 toFeishuElements 落成原生 hr
  }
}

/** NotifyDoc → 卡片 elements。相邻文本块合并成一个 div，减少卡片元素数。 */
export function toFeishuElements(doc: NotifyDoc, opts: FeishuRenderOptions = {}): object[] {
  const els: object[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    els.push({ tag: "div", text: { tag: "lark_md", content: buf.join("\n") } });
    buf = [];
  };
  for (const b of doc.blocks) {
    if (b.t === "divider") { flush(); els.push({ tag: "hr" }); continue; }
    const line = blockToLines(b, opts);
    if (line) buf.push(line);
  }
  flush();
  return els;
}

/** 只要一段 lark_md 字符串的场合（既有卡片的单 div 结构原地替换用）。 */
export function toLarkMd(doc: NotifyDoc, opts: FeishuRenderOptions = {}): string {
  return doc.blocks
    .map(b => (b.t === "divider" ? "———" : blockToLines(b, opts)))
    .filter((l): l is string => l != null)
    .join("\n");
}
