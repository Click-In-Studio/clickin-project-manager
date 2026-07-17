"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";
import {
  MENTION_PATTERN, deserializeMention,
  decodeMentionHref, CM_HREF_PREFIX,
  type ContentMentionAttrs,
} from "@/lib/mention-types";

// ── Public types ──────────────────────────────────────────────────────────────

export type MentionMember = { openId: string; name: string; avatarUrl?: string | null };

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

function extractCmLinks(text: string): { key: string; attrs: ContentMentionAttrs }[] {
  const pattern = /\[#[^\]]*\]\((cm:\/\/[^\s)"]+)\)/g;
  const out: { key: string; attrs: ContentMentionAttrs }[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const attrs = decodeMentionHref(m[1]);
    if (attrs) out.push({ key: m[1], attrs });
  }
  return out;
}

// ── Markdown inline renderer ──────────────────────────────────────────────────

// Splits on structural markdown tokens and HTML spans (old @ mention format)
const MD_INLINE_SPLIT = /(<span[^>]*>[\s\S]*?<\/span>|\*\*[^*]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|\[[^\]\n]*\]\([^\s)"]+(?:\s+"[^"]*")?\))/g;

function renderMdInline(
  text: string,
  keyBase: string,
  members: MentionMember[],
  resolved: ResolvedMap,
): React.ReactNode[] {
  const segments = text.split(MD_INLINE_SPLIT);
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const key = `${keyBase}-${i}`;

    // HTML span — old tiptap-markdown @mention: <span ...>@name</span>
    if (seg.startsWith("<span")) {
      const inner = seg.replace(/<[^>]+>/g, "");
      const name = inner.startsWith("@") ? inner.slice(1) : inner;
      nodes.push(<MemberChip key={key} name={name} members={members} />);
      continue;
    }
    // Bold
    if (seg.startsWith("**") && seg.endsWith("**")) {
      nodes.push(<strong key={key}>{renderMdInline(seg.slice(2, -2), `${key}-b`, members, resolved)}</strong>);
      continue;
    }
    // Italic
    if (seg.startsWith("*") && seg.endsWith("*")) {
      nodes.push(<em key={key}>{renderMdInline(seg.slice(1, -1), `${key}-i`, members, resolved)}</em>);
      continue;
    }
    // Strikethrough
    if (seg.startsWith("~~") && seg.endsWith("~~")) {
      nodes.push(<s key={key}>{renderMdInline(seg.slice(2, -2), `${key}-s`, members, resolved)}</s>);
      continue;
    }
    // Link: content mention, legacy script ref, or regular link
    if (seg.startsWith("[")) {
      const m = seg.match(/^\[([^\]]*)\]\(([^\s)"]+)(?:\s+"([^"]*)")?\)$/);
      if (m) {
        const [, linkText, href, title] = m;
        if (href.startsWith(CM_HREF_PREFIX)) {
          const r = resolved.get(href);
          const label = r?.label ?? linkText;
          const url = r?.url ? `${BASE_PATH}${r.url}` : null;
          nodes.push(<ContentChip key={key} label={label} deleted={label === "#[已删除]"} href={url} />);
          continue;
        }
        if (linkText.startsWith("#") && !href.startsWith("http")) {
          nodes.push(<ScriptChip key={key} label={linkText.slice(1)} href={href} title={title} />);
          continue;
        }
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
            {linkText}
          </a>
        );
        continue;
      }
    }

    // Plain text — scan for @member names
    if (members.length > 0) {
      const escaped = members.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const atRe = new RegExp(`(@(?:${escaped}))`, "g");
      const atParts = seg.split(atRe);
      if (atParts.length > 1) {
        atParts.forEach((part, pi) => {
          if (!part) return;
          if (members.some(m => part === `@${m.name}`)) {
            nodes.push(<MemberChip key={`${key}-at-${pi}`} name={part.slice(1)} members={members} />);
          } else {
            nodes.push(part);
          }
        });
        continue;
      }
    }

    nodes.push(seg);
  }

  return nodes;
}

// ── Markdown block renderer ───────────────────────────────────────────────────

function renderMdBlock(
  block: string,
  idx: number,
  members: MentionMember[],
  resolved: ResolvedMap,
): React.ReactNode {
  const lines = block.split("\n").filter(l => l.trim() !== "");
  if (!lines.length) return null;

  const headMatch = lines[0].match(/^(#{1,3}) (.+)$/);
  if (headMatch) {
    const level = headMatch[1].length;
    const cls = level === 1 ? "text-xl font-bold mt-4 mb-1"
      : level === 2 ? "text-lg font-semibold mt-3 mb-1"
      : "text-base font-semibold mt-2 mb-0.5";
    const Tag = `h${level}` as "h1" | "h2" | "h3";
    return <Tag key={idx} className={cls}>{renderMdInline(headMatch[2], `${idx}-h`, members, resolved)}</Tag>;
  }

  if (lines.every(l => /^[*-] /.test(l))) {
    return (
      <ul key={idx} className="list-disc pl-5 my-1 space-y-0.5">
        {lines.map((l, i) => (
          <li key={i} className="text-sm">{renderMdInline(l.slice(2), `${idx}-ul-${i}`, members, resolved)}</li>
        ))}
      </ul>
    );
  }

  if (lines.every(l => /^\d+\. /.test(l))) {
    return (
      <ol key={idx} className="list-decimal pl-5 my-1 space-y-0.5">
        {lines.map((l, i) => (
          <li key={i} className="text-sm">{renderMdInline(l.replace(/^\d+\. /, ""), `${idx}-ol-${i}`, members, resolved)}</li>
        ))}
      </ol>
    );
  }

  // Paragraph — split on TipTap hard breaks (\\\n)
  const hardParts = block.split(/\\\n/);
  const nodes: React.ReactNode[] = [];
  hardParts.forEach((part, i) => {
    nodes.push(...renderMdInline(part, `${idx}-p-${i}`, members, resolved));
    if (i < hardParts.length - 1) nodes.push(<br key={`${idx}-br-${i}`} />);
  });
  return <p key={idx} className="text-sm my-1">{nodes}</p>;
}

// ── SmartText ─────────────────────────────────────────────────────────────────

export default function SmartText({
  content,
  memberMention,
  contentMention,
  markdown = false,
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
  /** Render as markdown */
  markdown?: boolean;
  plugins?: InlinePlugin[];
  className?: string;
  productionId?: string;
  versionId?: string | null;
}) {
  const productionId = contentMention?.productionId ?? legacyProductionId;
  const versionId = contentMention?.versionId ?? legacyVersionId;
  const members = memberMention?.members ?? [];

  const [resolved, setResolved] = useState<ResolvedMap>(new Map());
  const resolveAttempted = useRef(false);

  useEffect(() => {
    if (!productionId || resolveAttempted.current) return;
    const items = markdown ? extractCmLinks(content) : extractPlainTokens(content);
    if (!items.length) return;
    resolveAttempted.current = true;

    fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mentions: items.map(t => t.attrs), versionId }),
    })
      .then(r => r.json())
      .then((data: { labels?: (string | null)[]; urls?: (string | null)[] }) => {
        if (!data.labels) return;
        const map: ResolvedMap = new Map();
        items.forEach((t, i) => {
          const label = data.labels![i];
          if (label) map.set(t.key, { label, url: data.urls?.[i] ?? null });
        });
        setResolved(map);
      })
      .catch(() => {});
  }, [content, productionId, versionId, markdown]);

  if (!content) return null;

  // ── Markdown mode ──────────────────────────────────────────────────────────
  if (markdown) {
    if (!content.trim()) return null;
    const blocks = content.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    return (
      <div className={`text-zinc-800 ${className ?? ""}`}>
        {blocks.map((block, i) => renderMdBlock(block, i, members, resolved))}
      </div>
    );
  }

  // ── Plain text mode ────────────────────────────────────────────────────────

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

  // Order: member → extra (legacy) plugins → content mention (must come last — [#label] is a prefix of [#label](href))
  const allPlugins: InlinePlugin[] = [
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
