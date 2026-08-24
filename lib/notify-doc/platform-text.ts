// 平台 renderer：NotifyDoc → 纯文本。
//
// 给"富不起来"的通道用（站内信摘要、短信、未来接入的纯文本平台）。
// 纪律同 G5：**形态全丢，字一个不丢**——链接壳去掉但保留文字，且当链接文字
// 与 URL 不同、URL 又是可点的绝对地址时，把 URL 缀在后面（纯文本里 URL 本身
// 就是可用信息，丢了等于丢了动作入口）。
import type { DocBlock, DocInline, NotifyDoc } from "./ast";

export type TextRenderOptions = {
  /** 是否保留 URL（站内信摘要这类场合可关掉，避免一屏都是链接） */
  keepUrls?: boolean;
  /** 站内相对路径 → 绝对地址；不给就只留文字（相对路径在纯文本里没有意义） */
  buildUrl?: (path: string) => string;
};

function inline(nodes: DocInline[], opts: TextRenderOptions): string {
  return nodes.map(n => {
    switch (n.t) {
      case "br": return "\n";
      case "at": return `@${n.name}`;
      case "text": return n.text;
      case "link": {
        if (opts.keepUrls === false || !n.url) return n.text;
        const url = n.url.startsWith("/") ? opts.buildUrl?.(n.url) : n.url;
        return url && url !== n.text ? `${n.text}（${url}）` : n.text;
      }
    }
  }).join("");
}

function block(b: DocBlock, opts: TextRenderOptions): string | null {
  switch (b.t) {
    case "p": return inline(b.children, opts);
    case "heading": return inline(b.children, opts);
    case "quote": return inline(b.children, opts);
    case "list":
      return b.items.map((it, i) => `${b.ordered ? `${i + 1}. ` : "· "}${inline(it, opts)}`).join("\n");
    case "code": return b.text;
    case "image": return b.alt ? `[图片：${b.alt}]` : "[图片]";
    case "divider": return null;
  }
}

export function toPlainText(doc: NotifyDoc, opts: TextRenderOptions = {}): string {
  return doc.blocks
    .map(b => block(b, opts))
    .filter((l): l is string => l != null && l !== "")
    .join("\n");
}

/** 单行摘要（站内信标题、列表副标题）：拍平换行、截断、不带 URL。 */
export function toSummary(doc: NotifyDoc, maxLen = 80): string {
  const s = toPlainText(doc, { keepUrls: false }).replace(/\s+/g, " ").trim();
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}
