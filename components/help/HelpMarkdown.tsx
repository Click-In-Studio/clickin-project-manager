// 使用手册正文渲染（#531）。服务端组件：react-markdown 10 无 hooks，可直接在 RSC 里跑，
// 手册页因此零客户端 JS。
//
// 刻意**不复用** components/wiki/WikiMarkdown：那条管线绑着 wiki 方言（/__cm__ mention
// chip、[[标题]] 双链、按观看者解析标签、嵌入资产 broker），手册是给未登录的外人看的
// 静态文档，一样都用不上。只借 callout 的 marker 语法（lib/editor/tiptap-callout），
// 作者在知识库里怎么写提示框，在手册里就怎么写。

import type { ReactNode, ReactElement } from "react";
import { Children, isValidElement } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { parseCalloutMarker } from "@/lib/editor/tiptap-callout";
import { HeadingIds, resolveManualLink } from "@/lib/help/manual";

// ── callout：blockquote 首段以 `[!emoji bg=#hex]` 开头 → 提示框 ────────────────
// 在 React children 层剥 marker 而不是改 markdown 字符串：marker 后的内容与正文
// 可能同段（remark-breaks 把换行渲染成 <br>），字符串层改写会碰坏行内结构。

function splitCallout(children: ReactNode): { emoji: string; color: string | null; rest: ReactNode[] } | null {
  const arr = Children.toArray(children);
  const idx = arr.findIndex((c) => isValidElement(c));
  if (idx < 0) return null;
  const p = arr[idx] as ReactElement<{ children?: ReactNode }>;
  const kids = Children.toArray(p.props.children);
  const first = kids[0];
  if (typeof first !== "string") return null;
  const marker = parseCalloutMarker(first);
  if (!marker) return null;
  let tail = kids.slice(1);
  const afterMarker = first.slice(marker.length).replace(/^\s+/, "");
  // marker 独占一行时，紧随其后的是 remark-breaks 产出的 <br>，一并剥掉
  if (!afterMarker && isValidElement(tail[0]) && tail[0].type === "br") tail = tail.slice(1);
  const restKids = afterMarker ? [afterMarker, ...tail] : tail;
  const rest = [...arr.slice(0, idx), ...(restKids.length ? [<p key="callout-first">{restKids}</p>] : []), ...arr.slice(idx + 1)];
  return { emoji: marker.emoji, color: marker.color, rest };
}

function externalHref(href: string): boolean {
  return /^[a-z]+:/i.test(href) || href.startsWith("//");
}

export default function HelpMarkdown({ body, slug }: { body: string; slug: string }) {
  // 与 lib/help/manual.extractHeadings 同一算法：目录锚点与正文 id 必须一致
  const ids = new HeadingIds();
  const headingText = (children: ReactNode): string =>
    Children.toArray(children).map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? headingText(c.props.children) : "")).join("");

  const components: Components = {
    h1: ({ children }) => <h2 className="help-h2">{children}</h2>,
    h2: ({ children }) => <h2 id={ids.next(headingText(children))} className="help-h2">{children}</h2>,
    h3: ({ children }) => <h3 id={ids.next(headingText(children))} className="help-h3">{children}</h3>,
    a: ({ href, children }) => {
      const h = href ?? "";
      if (externalHref(h)) return <a href={h} target="_blank" rel="noopener noreferrer">{children}</a>;
      const manualSlug = resolveManualLink(slug, h);
      if (manualSlug) {
        const anchor = h.includes("#") ? `#${h.split("#")[1]}` : "";
        return <Link href={`/help/${manualSlug}${anchor}`}>{children}</Link>;
      }
      return <Link href={h}>{children}</Link>;
    },
    img: ({ src, alt }) => (
      <span className="help-figure">
        <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" />
        {alt ? <span className="help-figcaption">{alt}</span> : null}
      </span>
    ),
    table: ({ children }) => <div className="help-table-wrap"><table>{children}</table></div>,
    blockquote: ({ children }) => {
      const callout = splitCallout(children);
      if (!callout) return <blockquote>{children}</blockquote>;
      return (
        <div className="help-callout" style={callout.color ? { background: callout.color } : undefined}>
          <span className="help-callout-emoji" aria-hidden>{callout.emoji}</span>
          <div className="help-callout-body">{callout.rest}</div>
        </div>
      );
    },
  };

  return (
    <div className="help-prose prose prose-zinc max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>{body}</ReactMarkdown>
    </div>
  );
}
