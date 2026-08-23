"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";
import {
  MENTION_PATTERN, deserializeMention,
  decodeMentionHref, CM_HREF_PREFIX,
  type ContentMentionAttrs,
} from "@/lib/mention-types";
import { normalizeLegacyMentions } from "@/lib/mention-format";

// ── Public types ──────────────────────────────────────────────────────────────

export type MentionMember = { userId: string; name: string; avatarUrl?: string | null };

// Kept for backward compat — callers that already pass plugins=[...] still work.
export type InlinePlugin = {
  pattern: string;
  render: (match: string, key: string) => React.ReactNode;
};

// ── Member chip (@ mention) ───────────────────────────────────────────────────

function MemberChip({ name, members }: { name: string; members: MentionMember[] }) {
  const [hovered, setHovered] = useState(false);
  const [above, setAbove] = useState(true);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const member = members.find(m => m.name === name);

  const handleMouseEnter = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setAbove(rect.top > window.innerHeight / 2);
    }
    setHovered(true);
  }, []);

  const avatar = member?.avatarUrl;
  const initial = name.charAt(0);

  return (
    <span className="relative inline-block">
      <span
        ref={triggerRef}
        className="font-medium text-blue-500 cursor-default"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setHovered(false)}
      >
        @{name}
      </span>
      {hovered && (
        <span className={`absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none ${
          above ? "bottom-full mb-2" : "top-full mt-2"
        }`}>
          <span className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl shadow-lg px-3 py-2 whitespace-nowrap">
            {avatar ? (
              <img src={avatar} alt={name} className="w-7 h-7 rounded-full object-cover shrink-0" />
            ) : (
              <span className="w-7 h-7 rounded-full bg-blue-50 text-blue-500 flex items-center justify-center text-xs font-semibold shrink-0">
                {initial}
              </span>
            )}
            <span className="text-sm font-medium text-zinc-800">{member?.name ?? name}</span>
          </span>
        </span>
      )}
    </span>
  );
}

// ── Content mention chip ──────────────────────────────────────────────────────

function ContentChip({ label, deleted, href }: { label: string; deleted?: boolean; href?: string | null }) {
  const cls = `inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 border border-amber-200 no-underline transition-colors ${
    deleted ? "text-zinc-400 line-through" : "text-amber-700 hover:bg-amber-100"
  }`;
  if (href) return <a href={href} className={cls}>{label}</a>;
  return <span className={cls}>{label}</span>;
}

// wiki 文档链接 chip——样式对齐 WikiMarkdown 的 [[标题]] sky 色处理（同一种引用，
// 不能在报告预览这一处看起来像剧本域的 # 引用）
function WikiChip({ label, href, state }: { label: string; href?: string | null; state?: "pending" | "failed" | "deleted" }) {
  if (state === "pending" || state === "failed") {
    return (
      <span
        title={state === "failed" ? "获取文档标题失败" : "解析中…"}
        className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-zinc-50 text-zinc-400 border border-dashed border-zinc-300"
      >
        [[{state === "failed" ? "获取失败" : "…"}]]
      </span>
    );
  }
  if (state === "deleted") {
    return (
      <span className="inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-zinc-50 text-zinc-400 border border-zinc-200 no-underline">
        [[已删除的文档]]
      </span>
    );
  }
  const cls = "inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-sky-50 text-sky-700 border border-sky-200 no-underline hover:bg-sky-100";
  return href
    ? <a href={href} className={cls}>[[{label}]]</a>
    : <span className={cls}>[[{label}]]</span>;
}

// ── Script chip (legacy [#label](href)) ──────────────────────────────────────

function ScriptChip({ label, href, title }: { label: string; href: string; title?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <span className="relative inline-block">
      <a
        href={href}
        className="inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 no-underline transition-colors"
        onMouseEnter={() => title && setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        #{label}
      </a>
      {hovered && title && (
        <span className="absolute bottom-full left-0 mb-1 z-50 bg-zinc-900 text-white text-xs px-2 py-1.5 rounded-lg whitespace-pre pointer-events-none leading-relaxed shadow-lg">
          {title}
        </span>
      )}
    </span>
  );
}

// ── Backward-compat plugin factories ─────────────────────────────────────────

export const scriptRefTextPlugin: InlinePlugin = {
  pattern: String.raw`\[#[^\]\n]*\]\([^\s)"]+(?:\s+"[^"]*")?\)`,
  render: (match, key) => {
    const m = match.match(/^\[#([^\]]*)\]\(([^\s)"]+)(?:\s+"([^"]*)")?\)$/);
    if (!m) return match;
    const [, label, href, title] = m;
    return <ScriptChip key={key} label={label} href={href} title={title} />;
  },
};

export function memberTextPlugin(mentions: { name: string }[]): InlinePlugin {
  if (!mentions.length) return { pattern: "(?!x)x", render: m => m };
  const escaped = mentions.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return {
    pattern: `@(?:${escaped})`,
    render: (match, key) => (
      <span key={key} className="font-medium text-blue-500">{match}</span>
    ),
  };
}

// ── Plain-text segment renderer ───────────────────────────────────────────────

function renderSegments(text: string, plugins: InlinePlugin[], keyBase: string): React.ReactNode[] {
  if (!plugins.length || !text) return text ? [text] : [];
  const n = plugins.length;
  const combined = new RegExp(plugins.map(p => `(${p.pattern})`).join("|"));
  const parts = text.split(combined);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += n + 1) {
    const plain = parts[i];
    if (plain) nodes.push(plain);
    for (let pi = 0; pi < n; pi++) {
      const match = parts[i + 1 + pi];
      if (match != null && match !== "") {
        nodes.push(plugins[pi].render(match, `${keyBase}-${i}-${pi}`));
        break;
      }
    }
  }
  return nodes;
}

// ── Mention token extraction ──────────────────────────────────────────────────

type ResolvedMap = Map<string, { label: string; url: string | null }>;

function extractPlainTokens(text: string): { key: string; attrs: ContentMentionAttrs }[] {
  const out: { key: string; attrs: ContentMentionAttrs }[] = [];
  MENTION_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_PATTERN.exec(text)) !== null) {
    const attrs = deserializeMention(m[0]);
    if (attrs) out.push({ key: m[0], attrs });
  }
  MENTION_PATTERN.lastIndex = 0;
  return out;
}

// ── SmartText ─────────────────────────────────────────────────────────────────

export default function SmartText({
  content,
  memberMention,
  contentMention,
  // backward-compat props
  plugins: extraPlugins = [],
  className,
  productionId: legacyProductionId,
  versionId: legacyVersionId,
}: {
  content: string;
  /** Enable @ member display with hover tooltip */
  memberMention?: { members: MentionMember[] };
  /** Enable # content mention resolution */
  contentMention?: { productionId: string; versionId?: string | null };
  plugins?: InlinePlugin[];
  className?: string;
  productionId?: string;
  versionId?: string | null;
}) {
  const productionId = contentMention?.productionId ?? legacyProductionId;
  const versionId = contentMention?.versionId ?? legacyVersionId;
  const members = memberMention?.members ?? [];

  const [resolved, setResolved] = useState<ResolvedMap>(new Map());
  const [resolveFailed, setResolveFailed] = useState(false);
  const resolveAttempted = useRef(false);

  useEffect(() => {
    if (!productionId || resolveAttempted.current) return;
    const items = extractPlainTokens(content);
    if (!items.length) return;
    resolveAttempted.current = true;

    fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mentions: items.map(t => t.attrs), versionId }),
    })
      .then(async (res) => {
        if (!res.ok) { setResolveFailed(true); return; }
        const data = await res.json() as { labels?: (string | null)[]; urls?: (string | null)[] };
        if (!data.labels) { setResolveFailed(true); return; }
        const map: ResolvedMap = new Map();
        items.forEach((t, i) => {
          const label = data.labels![i];
          if (label) map.set(t.key, { label, url: data.urls?.[i] ?? null });
        });
        setResolved(map);
      })
      .catch(() => setResolveFailed(true));
  }, [content, productionId, versionId]);

  if (!content) return null;

  // ── Plain text mode ────────────────────────────────────────────────────────

  // @ mention 完整 token：@[名](uid:x)——plain 模式编辑器的标准存储形态。
  // 原 memberPlugin 只匹配裸 @名字，带 uid 的 token 一直渲染为原文（用户实测）
  const atTokenPlugin: InlinePlugin = {
    pattern: String.raw`@\[[^\]\n]+\]\(uid:[^)\s]+\)`,
    render: (match, key) => {
      const name = /@\[([^\]\n]+)\]/.exec(match)?.[1] ?? match;
      return <MemberChip key={key} name={name} members={members} />;
    },
  };

  // Member mention plugin (with hover tooltip)
  const memberPlugin: InlinePlugin | null = members.length > 0 ? {
    pattern: (() => {
      const escaped = members.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      return `@(?:${escaped})`;
    })(),
    render: (match, key) => <MemberChip key={key} name={match.slice(1)} members={members} />,
  } : null;

  // Content mention plugin (resolved tokens)
  const cmPlugin: InlinePlugin = {
    pattern: String.raw`\[#[^\]\n]*\]`,
    render: (match, key) => {
      const r = resolved.get(match);
      if (r) {
        const href = r.url ? `${BASE_PATH}${r.url}` : null;
        return <ContentChip key={key} label={r.label} deleted={r.label === "#[已删除]"} href={href} />;
      }
      const attrs = deserializeMention(match);
      if (!attrs) return <span key={key} className="text-amber-600 font-mono text-[11px]">{match}</span>;
      const fallback = attrs.kind === "page" ? `#p.${attrs.id}` : attrs.kind === "cue" ? "#cue" : `#${attrs.kind}`;
      return <ContentChip key={key} label={fallback} />;
    },
  };

  // Order: @ 完整 token（必须先于裸 @名，避免被拆开）→ member → extra (legacy)
  // → content mention (must come last — [#label] is a prefix of [#label](href))
  const allPlugins: InlinePlugin[] = [
    atTokenPlugin,
    ...(memberPlugin ? [memberPlugin] : []),
    ...extraPlugins,
    cmPlugin,
  ];

  const lines = content.split("\n");
  const nodes: React.ReactNode[] = [];
  lines.forEach((line, li) => {
    if (li > 0) nodes.push(<br key={`br-${li}`} />);
    nodes.push(...renderSegments(line, allPlugins, `${li}`));
  });

  return (
    <span className={`text-sm break-words ${className ?? ""}`}>
      {nodes}
    </span>
  );
}
