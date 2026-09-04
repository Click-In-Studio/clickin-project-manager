"use client";

// wiki 文档库 W4：wiki 正文渲染管线。
// 弃用 SmartText 手写正则解析器（覆盖面窄），改走 react-markdown + remark-gfm
// （table/code block/嵌套列表/任务列表全量支持）。
// mention 链接与 @提及（统一为 /__cm__/<type>/<id> 引用 URI）用 components
// 覆写成 chip；标签经 mention-resolve 逐观看者刷新（§4.1：正文只存 id，
// label 是编辑期快照，渲染不信任它）。

import { Children, cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkColumns from "@/lib/remark-columns";
import { BASE_PATH } from "@/lib/base-path";
import { userAvatarSrc } from "@/lib/avatar-url";
import {
  decodeMentionHref, decodeUserHref, decodeAssetSrc, CM_HREF_PREFIX,
  type ContentMentionAttrs,
} from "@/lib/mention-types";
import { normalizeWikiDialect } from "@/lib/wiki/dialect-migrate";
import { parseCalloutMarker } from "@/lib/tiptap-callout";

type Resolved = { label: string | null; url: string | null };

function attrsKey(a: ContentMentionAttrs): string {
  return `${a.kind}:${a.id}:${a.aux ?? ""}:${a.versionId ?? ""}`;
}

// ── 手写 [[标题]] 支持（UI 修缮轮）────────────────────────────────────────────
// 源码模式/导入的正文会出现按标题手写的双链（含编辑器旧版转义产物 \[\[标题\]\]）。
// 渲染时按标题解析：命中可见文档 → 真链 chip；未命中 → 幻影 chip（Obsidian 语义）。
// 存储不变（正史仍是存 id 的 /__cm__/wiki/<id> 形态，§4-3 拍板不动摇）。

const RAW_CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
const RAW_WIKILINK_RE = /\[\[([^\[\]\n|#]+)\]\]/g;
const RAW_WIKILINK_ESCAPED_RE = /\\\[\\\[([^\[\]\\\n|#]+)\\\]\\\]/g;
const WT_HREF_PREFIX = "/__wt__";

/** 导出仅供单测：占位符嵌套曾把代码块吞掉，需要回归护栏 */
export function preprocessRawWikilinks(md: string): { text: string; titles: string[] } {
  // ⚠️ 顺序要紧：normalizeWikiDialect 必须在**本函数的占位保护之前**跑。
  // 它内部有自己一套同款 NUL 占位；若先在这里占位再调它，它的 restoreCode 会拿
  // 自己的空 parts 去"还原"本函数的占位符，把每段代码块直接替换成空串——正文里
  // 的代码会在渲染时被整个吞掉。
  // 历史版本正文（wiki_revision 不迁移）与回滚场景的 v1 形态兼容。
  const normalized = normalizeWikiDialect(md);
  // 码内的 [[]] 是语法示例，换占位保护（MindWeave protectCodeSpans 同款）
  const parts: string[] = [];
  let t = normalized.replace(RAW_CODE_RE, m => { parts.push(m); return `\u0000C${parts.length - 1}\u0000`; });
  const titles = new Set<string>();
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

// ── callout 方言渲染（> [!emoji|#color]，lib/tiptap-callout 同一 marker）─────
// blockquote 首段以 marker 开头 → 剥 marker 渲染成 callout 框；否则原样引用块。
// 在 React children 层剥（而非 markdown 字符串层）：marker 后内容可能与正文行
// 同段（remark-breaks 的 <br> 分行），字符串层改写会破坏 mention 链接等结构。

function splitCalloutChildren(children: ReactNode): { emoji: string; color: string | null; rest: ReactNode[] } | null {
  const arr = Children.toArray(children);
  const idx = arr.findIndex(c => isValidElement(c));
  if (idx < 0) return null;
  const p = arr[idx] as ReactElement<{ children?: ReactNode }>;
  const pKids = Children.toArray(p.props.children);
  const first = pKids[0];
  if (typeof first !== "string") return null;
  const marker = parseCalloutMarker(first);
  if (!marker) return null;
  const restFirst = first.slice(marker.length).replace(/^[ \t]*/, "");
  const newKids = [...pKids];
  if (restFirst) {
    newKids[0] = restFirst;
  } else {
    newKids.shift();
    // marker 独占一行时连同其后的 <br> 一起剥
    const next = newKids[0];
    if (isValidElement(next) && next.type === "br") newKids.shift();
  }
  const rest = [...arr];
  if (newKids.length === 0) rest.splice(idx, 1);
  else rest[idx] = cloneElement(p, {}, ...newKids);
  return { emoji: marker.emoji, color: marker.color, rest };
}

// ── 图片（![alt](/__cm__/asset/<id>)，正文只存 id）─────────────────────────────
// 初始 src 用 thumb（session 鉴权可直接流，秒出）；随后取 preview-url 换全尺寸
// 预签名 URL。取不到就停在缩略图，不空窗。

function CmAssetImage({ productionId, assetId, alt }: { productionId: string; assetId: string; alt?: string }) {
  const thumb = `${BASE_PATH}/api/production/${productionId}/assets/${assetId}/thumb`;
  const [src, setSrc] = useState(thumb);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/preview-url`);
        if (!res.ok) return;
        const data = await res.json() as { url?: string | null };
        if (alive && data.url) setSrc(data.url);
      } catch { /* 缩略图兜底 */ }
    })();
    return () => { alive = false; };
  }, [productionId, assetId]);
  return <img src={src} alt={alt ?? ""} className="wiki-image" loading="lazy" />;
}

// ── @提及 chip（hover 头像卡；原 SmartText 独有，合并时取强者）──────────────

function MemberChip({ name, members }: { name: string; members: MentionMember[] }) {
  const [hovered, setHovered] = useState(false);
  const [above, setAbove] = useState(true);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const member = members.find(m => m.name === name);

  return (
    <span className="relative inline-block">
      <span
        ref={triggerRef}
        className="font-medium text-blue-500 cursor-default"
        onMouseEnter={() => {
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) setAbove(rect.top > window.innerHeight / 2);
          setHovered(true);
        }}
        onMouseLeave={() => setHovered(false)}
      >
        @{name}
      </span>
      {hovered && member && (
        <span className={`absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none ${above ? "bottom-full mb-2" : "top-full mt-2"}`}>
          <span className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl shadow-lg px-3 py-2 whitespace-nowrap">
            {userAvatarSrc(member.userId, member.avatarUrl)
              ? <img src={userAvatarSrc(member.userId, member.avatarUrl) ?? undefined} alt={name} className="w-7 h-7 rounded-full object-cover shrink-0" />
              : <span className="w-7 h-7 rounded-full bg-blue-50 text-blue-500 flex items-center justify-center text-xs font-semibold shrink-0">{name.charAt(0)}</span>}
            <span className="text-sm font-medium text-zinc-800">{member.name}</span>
          </span>
        </span>
      )}
    </span>
  );
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

export type MentionMember = { userId: string; name: string; avatarUrl?: string | null };

/** 块级语义在 inline 变体里降级成纯内容（不吃字）：`<div>` 落进 `<span>` 是非法
 *  嵌套，会在表格单元格/`<dd>` 这类宿主里把布局撑坏。 */
const BLOCK_ELEMENTS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
];

export default function WikiMarkdown({
  content,
  productionId,
  className = "",
  inline = false,
  members = [],
  versionId,
  wikiRouteBase,
}: {
  content: string;
  /** 统一 renderer：production 上下文之外（全站通知/管理公告）可省略——
   *  mention/wiki 链/asset 图片优雅降级（无法解析态/幻影/占位），方言排版照常 */
  productionId?: string;
  className?: string;
  /** 行内变体：输出 `<span>`，块级语义降级为纯内容。用于表格单元格、`<dd>`、
   *  卡片副标题这类只能放行内元素的宿主（原 SmartText 的全部用法）。 */
  inline?: boolean;
  /** @提及的成员表：命中则 hover 显示头像卡 */
  members?: MentionMember[];
  /** 解析上下文版本：正文里没写 ?v= 的剧本域引用按此版本解析 */
  versionId?: string | null;
  /** wiki 目标的路由命名空间（默认 /production/<id>/wiki）。作用域化工作区
   *  （如构作·灵感文档）传自己的 base，内链才不会把人弹出工作区。 */
  wikiRouteBase?: string;
}) {
  // 手写 [[标题]] 预处理（码内保护）+ 标题清单
  const { text: processed, titles: rawTitles } = useMemo(
    () => preprocessRawWikilinks(content), [content]);

  // 标题 → id 解析（一次取可见库清单，精确匹配；未命中=幻影）
  const [titleMap, setTitleMap] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (rawTitles.length === 0) { setTitleMap(null); return; }
    if (!productionId) { setTitleMap(new Map()); return; } // 无 production 上下文：全部幻影
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
    if (!productionId) { setResolveFailed(true); return; } // 无上下文：chip 落「无法解析」态
    const sig = mentionAttrs.map(attrsKey).join("|");
    if (attemptedRef.current === sig) return;
    attemptedRef.current = sig;
    setResolveFailed(false);
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mentions: mentionAttrs, versionId }),
        });
        if (!res.ok) { setResolveFailed(true); return; }
        const data = await res.json() as { labels: (string | null)[]; urls: (string | null)[] };
        const next = new Map<string, Resolved>();
        mentionAttrs.forEach((a, i) => next.set(attrsKey(a), { label: data.labels[i], url: data.urls[i] }));
        setResolved(next);
      } catch { setResolveFailed(true); }
    })();
  }, [mentionAttrs, productionId, versionId]);

  const wikiBase = wikiRouteBase ?? `/production/${productionId}/wiki`;

  const Wrapper = inline ? "span" : "div";
  const wrapperClass = inline
    ? `text-sm break-words ${className}`
    : `prose prose-zinc max-w-none ${className}`;

  return (
    <Wrapper className={wrapperClass}>
      <ReactMarkdown
        // breaks：单回车即换行（对齐 MindWeave 与编辑器 tiptap breaks:true——CJK 写作习惯）
        remarkPlugins={[remarkGfm, remarkBreaks, remarkColumns]}
        {...(inline ? { disallowedElements: BLOCK_ELEMENTS, unwrapDisallowed: true } : {})}
        components={{
          ...(inline ? { p: ({ children }: { children?: ReactNode }) => <>{children}</> } : {}),
          blockquote: ({ children }) => {
            const callout = splitCalloutChildren(children);
            if (!callout) return <blockquote>{children}</blockquote>;
            return (
              <div
                className="wiki-callout not-prose text-[15px] leading-relaxed text-zinc-800"
                data-emoji={callout.emoji}
                style={callout.color ? { ["--callout-bg" as string]: callout.color } : undefined}
              >
                {callout.rest}
              </div>
            );
          },
          img: ({ src, alt }) => {
            const s = typeof src === "string" ? src : "";
            const assetId = decodeAssetSrc(s); // 新旧形态双读（历史版本）
            if (assetId && !productionId) {
              return <span className="inline-flex items-center px-1 py-0.5 rounded text-[12px] bg-zinc-50 text-zinc-400 border border-dashed border-zinc-300">[图片{alt ? `：${alt}` : ""}]</span>;
            }
            if (assetId && productionId) return <CmAssetImage productionId={productionId} assetId={assetId} alt={alt} />;
            return <img src={s} alt={alt ?? ""} className="wiki-image" loading="lazy" />;
          },
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
            // @成员提及：[@名](/__cm__/user/<id>)
            // 旧 uid: 形态在这里**恒不可达**——react-markdown 的 defaultUrlTransform
            // 把未知协议剥成空串，href 到不了这儿（这正是它一直渲染不出 chip 的根因）。
            // decodeUserHref 的 uid: 兼容分支服务的是编辑器 parseHTML 路径（无 sanitizer）。
            if (decodeUserHref(h)) {
              const name = String(children ?? "").replace(/^@/, "");
              return <MemberChip name={name} members={members} />;
            }
            // 手写 [[标题]]：按标题解析——命中真链 / 未命中幻影 / 解析中素样式
            if (h.startsWith(WT_HREF_PREFIX)) {
              const title = decodeURIComponent(h.slice(WT_HREF_PREFIX.length));
              const targetId = titleMap?.get(title);
              if (targetId) {
                return (
                  <Link
                    href={`${wikiBase}/${targetId}`}
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
            // content mention：[#](/__cm__/<type>/<id>?params)
            if (h.startsWith(CM_HREF_PREFIX)) {
              const attrs = decodeMentionHref(h);
              if (!attrs) return <span>{children}</span>;
              const r = resolved.get(attrsKey(attrs));
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
                // r.url 对 wiki kind 恒为 /production/<id>/wiki/<id>（mention-resolve），
                // 所以有 base 覆盖时直接自建，不拿它当真相。
                const url = wikiRouteBase
                  ? `${wikiRouteBase}/${attrs.id}`
                  : r.url ?? `${wikiBase}/${attrs.id}`;
                return (
                  <Link
                    href={url}
                    className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-sky-50 text-sky-700 border border-sky-200 no-underline hover:bg-sky-100"
                  >
                    [[{r.label}]]
                  </Link>
                );
              }
              // 显示位已恒为哨兵 "#"（不再是编辑期 label 快照），解析不出来就没有
              // 任何可显示的东西——给中性占位，绝不拿正文里的字冒充实时标签。
              if (!r) {
                return (
                  <span
                    title={resolveFailed ? "解析失败" : "解析中…"}
                    className="inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-zinc-50 text-zinc-400 border border-dashed border-zinc-300"
                  >
                    #{resolveFailed ? "解析失败" : "…"}
                  </span>
                );
              }
              const label = r.label ?? attrs.kind;
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
    </Wrapper>
  );
}
