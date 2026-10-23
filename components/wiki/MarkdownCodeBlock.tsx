"use client";

import { useEffect, useState } from "react";

const cache = new Map<string, string>();
const requests = new Map<string, Promise<string>>();

export default function MarkdownCodeBlock({ code, lang, pending = false }: {
  code: string; lang?: string; pending?: boolean;
}) {
  const key = `${lang ?? ""} ${code}`;
  const [highlight, setHighlight] = useState<{ key: string; html: string } | null>(null);
  useEffect(() => {
    if (pending || !lang) return;
    let alive = true;
    const cached = cache.get(key);
    if (cached !== undefined) {
      // 缓存可能在 render 与 effect 之间由旧实例填入（#1048）。
      setHighlight(previous => previous?.key === key && previous.html === cached ? previous : { key, html: cached });
      return;
    }
    let request = requests.get(key);
    if (!request) {
      request = import("shiki")
        .then(({ codeToHtml }) => codeToHtml(code, { lang, theme: "github-light" }))
        .then(html => { cache.set(key, html); return html; })
        .finally(() => requests.delete(key));
      requests.set(key, request);
    }
    request.then(html => { if (alive) setHighlight({ key, html }); })
      .catch(() => { /* 未知语言保持普通代码排版。 */ });
    return () => { alive = false; };
  }, [code, key, lang, pending]);

  if (pending) return <div className="not-prose whitespace-pre-wrap break-words" data-streaming-code>{code}</div>;
  const html = highlight?.key === key ? highlight.html : cache.get(key);
  if (html) return <div className="wiki-code [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto text-[13px]" dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre className="rounded-lg bg-zinc-50 p-3 overflow-x-auto text-[13px]"><code>{code}</code></pre>;
}
