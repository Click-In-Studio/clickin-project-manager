"use client";

import { useState, useEffect, useRef } from "react";
import { BASE_PATH } from "@/lib/base-path";
import {
  MENTION_PATTERN, deserializeMention,
  type ContentMentionAttrs,
} from "@/lib/mention-types";

// ── Plugin type ───────────────────────────────────────────────────────────────

export type InlinePlugin = {
  pattern: string;
  render: (match: string, key: string) => React.ReactNode;
};

// ── Content mention chip ──────────────────────────────────────────────────────

function ContentChip({ displayLabel, deleted, href }: { displayLabel: string; deleted?: boolean; href?: string | null }) {
  const cls = `inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 border border-amber-200 no-underline transition-colors ${
    deleted ? "text-zinc-400 line-through" : "text-amber-700 hover:bg-amber-100"
  }`;
  if (href) {
    return <a href={href} className={cls}>{displayLabel}</a>;
  }
  return <span className={cls}>{displayLabel}</span>;
}

// ── Legacy script-ref chip (kept for backward compat with old [#label](href) format) ──

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

// ── Built-in plugins ──────────────────────────────────────────────────────────

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
  if (!mentions.length) {
    return { pattern: "(?!x)x", render: (m) => m };
  }
  const escaped = mentions
    .map((m) => m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return {
    pattern: `@(?:${escaped})`,
    render: (match, key) => (
      <span key={key} className="font-medium text-blue-500">{match}</span>
    ),
  };
}

// ── Core renderer ─────────────────────────────────────────────────────────────

function renderSegments(text: string, plugins: InlinePlugin[], keyBase: string): React.ReactNode[] {
  if (!plugins.length || !text) return text ? [text] : [];

  const n = plugins.length;
  const combined = new RegExp(plugins.map((p) => `(${p.pattern})`).join("|"));
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

// ── Mention token parsing ─────────────────────────────────────────────────────

type MentionToken = { token: string; attrs: ContentMentionAttrs };

function extractMentionTokens(text: string): MentionToken[] {
  const out: MentionToken[] = [];
  MENTION_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_PATTERN.exec(text)) !== null) {
    const attrs = deserializeMention(m[0]);
    if (attrs) out.push({ token: m[0], attrs });
  }
  MENTION_PATTERN.lastIndex = 0;
  return out;
}

// ── SmartText ─────────────────────────────────────────────────────────────────

export default function SmartText({
  content,
  plugins = [],
  className,
  productionId,
  versionId,
}: {
  content: string;
  plugins?: InlinePlugin[];
  className?: string;
  productionId?: string;
  versionId?: string | null;
}) {
  // Map from mention token string → { label, url }
  const [resolved, setResolved] = useState<Map<string, { label: string; url: string | null }>>(new Map());
  const resolveAttempted = useRef(false);

  useEffect(() => {
    if (!productionId || resolveAttempted.current) return;
    const tokens = extractMentionTokens(content);
    if (tokens.length === 0) return;
    resolveAttempted.current = true;

    const mentions = tokens.map(t => t.attrs);
    fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mentions, versionId }),
    })
      .then(r => r.json())
      .then((data: { labels?: (string | null)[]; urls?: (string | null)[] }) => {
        if (!data.labels) return;
        const map = new Map<string, { label: string; url: string | null }>();
        tokens.forEach((t, i) => {
          const label = data.labels![i];
          if (label) map.set(t.token, { label, url: data.urls?.[i] ?? null });
        });
        setResolved(map);
      })
      .catch(() => {});
  }, [content, productionId, versionId]);

  if (!content) return null;

  // Build a content mention plugin that uses resolved labels and URLs
  const cmPattern = String.raw`\[#[^\]\n]*\]`;
  const contentMentionPlugin: InlinePlugin = {
    pattern: cmPattern,
    render: (match, key) => {
      const r = resolved.get(match);
      if (r) {
        const href = r.url ? `${BASE_PATH}${r.url}` : null;
        return (
          <ContentChip
            key={key}
            displayLabel={r.label}
            deleted={r.label === "#[已删除]"}
            href={href}
          />
        );
      }
      // Fallback: parse attrs from token and show kind/id
      const attrs = deserializeMention(match);
      if (!attrs) return <span key={key} className="text-amber-600 font-mono text-[11px]">{match}</span>;
      const fallbackLabel = attrs.kind === "page"
        ? `#p.${attrs.id}`
        : attrs.kind === "cue" ? "#cue"
        : `#${attrs.kind}`;
      return <ContentChip key={key} displayLabel={fallbackLabel} />;
    },
  };

  // contentMentionPlugin must come LAST — the old [#label](href) format has [#label] as a prefix,
  // so scriptRefTextPlugin (which matches the full link) must win first via alternation order.
  const allPlugins = [...plugins, contentMentionPlugin];
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
