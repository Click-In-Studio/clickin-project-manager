"use client";

// wiki 文档库 W4：wiki 正文渲染管线。
// 弃用 SmartText 手写正则解析器（覆盖面窄），改走 react-markdown + remark-gfm
// （table/code block/嵌套列表/任务列表全量支持）。
// mention 链接（/__cm__kind:id 私有 href）与 @提及（uid: href）用 components
// 覆写成 chip；标签经 mention-resolve 逐观看者刷新（§4.1：正文只存 id，
// label 是编辑期快照，渲染不信任它）。

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BASE_PATH } from "@/lib/base-path";
import {
  decodeMentionHref, CM_HREF_PREFIX, type ContentMentionAttrs,
} from "@/lib/mention-types";

type Resolved = { label: string | null; url: string | null };

function attrsKey(a: ContentMentionAttrs): string {
  return `${a.kind}:${a.id}:${a.aux ?? ""}:${a.versionId ?? ""}`;
}

export default function WikiMarkdown({
  content,
  productionId,
  className = "",
}: {
  content: string;
  productionId: string;
  className?: string;
}) {
  // 收集正文中全部 content mention，批量 resolve 一次
  const mentionAttrs = useMemo(() => {
    const seen = new Map<string, ContentMentionAttrs>();
    for (const m of content.matchAll(/\]\((\/__cm__[^)]+)\)/g)) {
      const attrs = decodeMentionHref(m[1]);
      if (attrs) seen.set(attrsKey(attrs), attrs);
    }
    return [...seen.values()];
  }, [content]);

  const [resolved, setResolved] = useState<Map<string, Resolved>>(new Map());
  const attemptedRef = useRef("");

  useEffect(() => {
    if (mentionAttrs.length === 0) return;
    const sig = mentionAttrs.map(attrsKey).join("|");
    if (attemptedRef.current === sig) return;
    attemptedRef.current = sig;
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mentions: mentionAttrs }),
        });
        if (!res.ok) return;
        const data = await res.json() as { labels: (string | null)[]; urls: (string | null)[] };
        const next = new Map<string, Resolved>();
        mentionAttrs.forEach((a, i) => next.set(attrsKey(a), { label: data.labels[i], url: data.urls[i] }));
        setResolved(next);
      } catch { /* 保持编辑期快照 label */ }
    })();
  }, [mentionAttrs, productionId]);

  return (
    <div className={`prose prose-zinc max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const h = href ?? "";
            // @成员提及：@[名](uid:xxx)
            if (h.startsWith("uid:")) {
              return <span className="font-medium text-blue-600 no-underline">{children}</span>;
            }
            // content mention：[#label](/__cm__kind:id)
            if (h.startsWith(CM_HREF_PREFIX)) {
              const attrs = decodeMentionHref(h);
              if (!attrs) return <span>{children}</span>;
              const r = resolved.get(attrsKey(attrs));
              const snapshot = String(children ?? "").replace(/^#/, "");
              if (attrs.kind === "wiki") {
                const label = r?.label ?? snapshot;
                const url = r?.url ?? `/production/${productionId}/wiki/${attrs.id}`;
                const deleted = r && r.label === "#[已删除]";
                if (deleted) {
                  return (
                    <span className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-zinc-50 text-zinc-400 border border-zinc-200 no-underline">
                      [[已删除的文档]]
                    </span>
                  );
                }
                return (
                  <Link
                    href={url}
                    className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-sky-50 text-sky-700 border border-sky-200 no-underline hover:bg-sky-100"
                  >
                    [[{label}]]
                  </Link>
                );
              }
              const label = r?.label ?? `#${snapshot}`;
              const chip = (
                <span className="inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 text-amber-700 border border-amber-200 no-underline">
                  {label.startsWith("#") ? label : `#${label}`}
                </span>
              );
              return r?.url ? <Link href={r.url} className="no-underline">{chip}</Link> : chip;
            }
            // 普通链接
            return (
              <a href={h} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline underline-offset-2">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
