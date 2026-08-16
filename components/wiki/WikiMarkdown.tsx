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
import remarkBreaks from "remark-breaks";
import { BASE_PATH } from "@/lib/base-path";
import {
  decodeMentionHref, CM_HREF_PREFIX, type ContentMentionAttrs,
} from "@/lib/mention-types";
import { normalizeLegacyMentions } from "@/lib/mention-format";

type Resolved = { label: string | null; url: string | null };

function attrsKey(a: ContentMentionAttrs): string {
  return `${a.kind}:${a.id}:${a.aux ?? ""}:${a.versionId ?? ""}`;
}

// ── 手写 [[标题]] 支持（UI 修缮轮）────────────────────────────────────────────
// 源码模式/导入的正文会出现按标题手写的双链（含编辑器旧版转义产物 \[\[标题\]\]）。
// 渲染时按标题解析：命中可见文档 → 真链 chip；未命中 → 幻影 chip（Obsidian 语义）。
// 存储不变（正史仍是存 id 的 /__cm__wiki: 形态，§4-3 拍板不动摇）。

const RAW_CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
const RAW_WIKILINK_RE = /\[\[([^\[\]\n|#]+)\]\]/g;
const RAW_WIKILINK_ESCAPED_RE = /\\\[\\\[([^\[\]\\\n|#]+)\\\]\\\]/g;
const WT_HREF_PREFIX = "/__wt__";

function preprocessRawWikilinks(md: string): { text: string; titles: string[] } {
  // 码内的 [[]] 是语法示例，先换占位保护（MindWeave protectCodeSpans 同款）
  const parts: string[] = [];
  let t = md.replace(RAW_CODE_RE, m => { parts.push(m); return `\u0000C${parts.length - 1}\u0000`; });
  const titles = new Set<string>();
  // 存量/损坏 mention 抢救（共享归一化）
  t = normalizeLegacyMentions(t);
  const sub = (_m: string, title: string) => {
    const tt = title.trim();
    if (!tt) return _m;
    titles.add(tt);
    return `[${tt}](${WT_HREF_PREFIX}${encodeURIComponent(tt)})`;
  };
  t = t.replace(RAW_WIKILINK_ESCAPED_RE, sub);
  t = t.replace(RAW_WIKILINK_RE, sub);
  t = t.replace(/\u0000C(\d+)\u0000/g, (_m, i) => parts[Number(i)] ?? "");
  return { text: t, titles: [...titles] };
}

// ── 代码高亮（shiki 懒加载，MindWeave 同款思路；亮色主题贴纸面 UI 与打印）────

const shikiCache = new Map<string, string>();

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const cacheKey = `${lang ?? ""} ${code}`;
  const [html, setHtml] = useState<string | null>(() => shikiCache.get(cacheKey) ?? null);
  useEffect(() => {
    if (!lang || shikiCache.has(cacheKey)) return;
    let alive = true;
    import("shiki")
      .then(({ codeToHtml }) => codeToHtml(code, { lang, theme: "github-light" }))
      .then(h => { shikiCache.set(cacheKey, h); if (alive) setHtml(h); })
      .catch(() => { /* 未知语言/加载失败 → 保持素排版 */ });
    return () => { alive = false; };
  }, [cacheKey, code, lang]);

  if (html) {
    return <div className="wiki-code [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto text-[13px]" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <pre className="rounded-lg bg-zinc-50 p-3 overflow-x-auto text-[13px]"><code>{code}</code></pre>;
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
  // 手写 [[标题]] 预处理（码内保护）+ 标题清单
  const { text: processed, titles: rawTitles } = useMemo(
    () => preprocessRawWikilinks(content), [content]);

  // 标题 → id 解析（一次取可见库清单，精确匹配；未命中=幻影）
  const [titleMap, setTitleMap] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (rawTitles.length === 0) { setTitleMap(null); return; }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`);
        if (!res.ok) { if (alive) setTitleMap(new Map()); return; }
        const data = await res.json() as { wikis?: { id: string; title: string | null }[] };
        const map = new Map<string, string>();
        for (const w of data.wikis ?? []) {
          if (w.title && !map.has(w.title)) map.set(w.title, w.id);
        }
        if (alive) setTitleMap(map);
      } catch { if (alive) setTitleMap(new Map()); }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTitles.join(" "), productionId]);

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
  const [resolveFailed, setResolveFailed] = useState(false);
  const attemptedRef = useRef("");

  useEffect(() => {
    if (mentionAttrs.length === 0) return;
    const sig = mentionAttrs.map(attrsKey).join("|");
    if (attemptedRef.current === sig) return;
    attemptedRef.current = sig;
    setResolveFailed(false);
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mentions: mentionAttrs }),
        });
        if (!res.ok) { setResolveFailed(true); return; }
        const data = await res.json() as { labels: (string | null)[]; urls: (string | null)[] };
        const next = new Map<string, Resolved>();
        mentionAttrs.forEach((a, i) => next.set(attrsKey(a), { label: data.labels[i], url: data.urls[i] }));
        setResolved(next);
      } catch { setResolveFailed(true); }
    })();
  }, [mentionAttrs, productionId]);

  return (
    <div className={`prose prose-zinc max-w-none ${className}`}>
      <ReactMarkdown
        // breaks：单回车即换行（对齐 MindWeave 与编辑器 tiptap breaks:true——CJK 写作习惯）
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          pre: ({ children }) => {
            // 解包 <pre><code class="language-x">：交给 shiki（未知语言/无语言留素排版）
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const child: any = Array.isArray(children) ? children[0] : children;
            const cls: string = child?.props?.className ?? "";
            const lang = /language-([\w+-]+)/.exec(cls)?.[1];
            const code = String(child?.props?.children ?? "").replace(/\n$/, "");
            return <CodeBlock code={code} lang={lang} />;
          },
          a: ({ href, children }) => {
            const h = href ?? "";
            // @成员提及：@[名](uid:xxx)
            if (h.startsWith("uid:")) {
              return <span className="font-medium text-blue-600 no-underline">{children}</span>;
            }
            // 手写 [[标题]]：按标题解析——命中真链 / 未命中幻影 / 解析中素样式
            if (h.startsWith(WT_HREF_PREFIX)) {
              const title = decodeURIComponent(h.slice(WT_HREF_PREFIX.length));
              const targetId = titleMap?.get(title);
              if (targetId) {
                return (
                  <Link
                    href={`/production/${productionId}/wiki/${targetId}`}
                    className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-sky-50 text-sky-700 border border-sky-200 no-underline hover:bg-sky-100"
                  >
                    [[{title}]]
                  </Link>
                );
              }
              return (
                <span
                  title={titleMap ? "未找到同名文档" : "解析中…"}
                  className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-zinc-50 text-zinc-400 border border-dashed border-zinc-300"
                >
                  [[{title}]]
                </span>
              );
            }
            // content mention：[#label](/__cm__kind:id)
            if (h.startsWith(CM_HREF_PREFIX)) {
              const attrs = decodeMentionHref(h);
              if (!attrs) return <span>{children}</span>;
              const r = resolved.get(attrsKey(attrs));
              const snapshot = String(children ?? "").replace(/^#/, "");
              if (attrs.kind === "wiki") {
                // 标题恒不信任正文快照——不管快照是不是最新的，一律以 resolve 结果为准；
                // resolve 未完成/失败时给中性占位，不能拿旧快照顶上去冒充"当前标题"。
                if (!r) {
                  return (
                    <span
                      title={resolveFailed ? "获取文档标题失败" : "解析中…"}
                      className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-zinc-50 text-zinc-400 border border-dashed border-zinc-300"
                    >
                      [[{resolveFailed ? "获取失败" : "…"}]]
                    </span>
                  );
                }
                const deleted = r.label === "#[已删除]";
                if (deleted) {
                  return (
                    <span className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-zinc-50 text-zinc-400 border border-zinc-200 no-underline">
                      [[已删除的文档]]
                    </span>
                  );
                }
                const url = r.url ?? `/production/${productionId}/wiki/${attrs.id}`;
                return (
                  <Link
                    href={url}
                    className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-sky-50 text-sky-700 border border-sky-200 no-underline hover:bg-sky-100"
                  >
                    [[{r.label}]]
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
        {processed}
      </ReactMarkdown>
    </div>
  );
}
