// 平台 renderer：NotifyDoc → 邮件 HTML。
//
// 邮件是「能富」的通道，所以它拿的不该是别的通道的方言文本（lark_md 里的
// `**粗体**` / `• ` / `▏` 在邮件里会原样显示给用户）。
//
// 邮件 HTML 的两条硬约束：
//   1. **必须转义**。原先模板是 `.replace(/<[^>]*>/g,"")` 剥标签后直接拼进
//      HTML——那是"看起来像消毒"的写法：剥不掉实体、也挡不住 `&` 之类，
//      而且一旦哪天正文里出现 `<` 开头的文本就会被吃掉。这里一律走 escape。
//   2. **样式必须内联**。邮件客户端普遍不支持 <style>/外部样式表。
import type { DocBlock, DocInline, NotifyDoc } from "./ast";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type HtmlRenderOptions = {
  /** 站内相对路径 → 绝对地址（邮件里相对路径完全不可用） */
  buildUrl?: (path: string) => string;
  /** 正文色 / 链接色，跟随邮件模板的调色板 */
  ink?: string;
  link?: string;
  muted?: string;
};

function inline(nodes: DocInline[], o: HtmlRenderOptions): string {
  return nodes.map(n => {
    switch (n.t) {
      case "br": return "<br>";
      case "at":
        return `<span style="color:${o.link ?? "#2563eb"};font-weight:600">@${esc(n.name)}</span>`;
      case "link": {
        const url = n.url.startsWith("/") ? o.buildUrl?.(n.url) : n.url;
        if (!url) return esc(n.text); // 绝对化不了就只留文字，不给死链
        return `<a href="${esc(url)}" style="color:${o.link ?? "#2563eb"};text-decoration:underline">${esc(n.text)}</a>`;
      }
      case "text": {
        let s = esc(n.text);
        if (n.code) s = `<code style="font-family:ui-monospace,Menlo,monospace;font-size:.92em">${s}</code>`;
        if (n.bold) s = `<strong>${s}</strong>`;
        if (n.italic) s = `<em>${s}</em>`;
        return s;
      }
    }
  }).join("");
}

function block(b: DocBlock, o: HtmlRenderOptions): string {
  const ink = o.ink ?? "#18181b";
  const muted = o.muted ?? "#71717a";
  switch (b.t) {
    case "p":
      return `<p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:${muted}">${inline(b.children, o)}</p>`;
    case "heading":
      return `<p style="margin:14px 0 6px;font-size:14px;font-weight:700;color:${ink}">${inline(b.children, o)}</p>`;
    case "quote":
      return `<div style="margin:0 0 10px;padding-left:10px;border-left:3px solid #e4e4e7;font-size:13px;line-height:1.6;color:${muted}">${inline(b.children, o)}</div>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const items = b.items.map(it => `<li style="margin:0 0 4px">${inline(it, o)}</li>`).join("");
      return `<${tag} style="margin:0 0 10px;padding-left:20px;font-size:13px;line-height:1.6;color:${muted}">${items}</${tag}>`;
    }
    case "code":
      return `<pre style="margin:0 0 10px;padding:8px 10px;background:#fafafa;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;color:${ink};white-space:pre-wrap">${esc(b.text)}</pre>`;
    case "divider":
      return `<hr style="border:none;border-top:1px solid #e4e4e7;margin:14px 0">`;
    case "image":
      // 邮件里的图片要么内嵌 CID 要么绝对 URL，两者都需要鉴权换算——
      // 这一层没有那个上下文，降级成 alt 文字（不吃内容）
      return `<p style="margin:0 0 10px;font-size:12px;color:${muted}">${esc(b.alt ? `［图片：${b.alt}］` : "［图片］")}</p>`;
  }
}

export function toEmailHtml(doc: NotifyDoc, opts: HtmlRenderOptions = {}): string {
  return doc.blocks.map(b => block(b, opts)).join("");
}
