"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Mention } from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { match as pinyinMatch } from "pinyin-pro";
import { BASE_PATH } from "@/lib/base-path";
import type { JSONContent } from "@tiptap/react";
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { ScriptBlockSearchResult } from "@/app/api/production/[id]/script/block-search/route";
import type { MentionMember } from "./MentionTextarea";

// ── Plugin types ──────────────────────────────────────────────────────────────

export type DropItem = { id: string; label: string; secondary?: string };

export type DropPlugin = {
  trigger: string;
  allowSpaces?: boolean;
  emptyLabel?: string;
  search: (query: string) => Promise<DropItem[]> | DropItem[];
  renderItem: (item: DropItem, active: boolean) => React.ReactNode;
  format: (item: DropItem) => string;
  onPick?: (item: DropItem) => void;
  // Returns attrs for the TipTap mention node (used instead of format() in rich mode)
  toNode?: (item: DropItem) => Record<string, unknown>;
};

// ── Factory: @member ──────────────────────────────────────────────────────────

export function memberDropPlugin(
  members: MentionMember[],
  opts?: { onPick?: (m: MentionMember) => void },
): DropPlugin {
  return {
    trigger: "@",
    emptyLabel: "无匹配成员",
    search: (query) => {
      const list = !query
        ? members.slice(0, 6)
        : members.filter(m =>
            m.name.includes(query) || pinyinMatch(m.name, query.toLowerCase()) != null
          ).slice(0, 6);
      return list.map(m => ({ id: m.openId, label: m.name }));
    },
    renderItem: (item) => <span className="text-sm">{item.label}</span>,
    format: (item) => `@${item.label}`,
    onPick: opts?.onPick ? (item) => opts.onPick!({ openId: item.id, name: item.label }) : undefined,
    toNode: (item) => ({ id: item.id, label: item.label }),
  };
}

// ── Factory: #script ref ──────────────────────────────────────────────────────

export function scriptRefDropPlugin(productionId: string, versionId?: string | null): DropPlugin {
  return {
    trigger: "#",
    emptyLabel: versionId === null ? "请先为活动选择版本" : "无匹配内容",
    search: async (query) => {
      if (!query) return [];
      if (versionId === null) return [];
      try {
        const params = new URLSearchParams({ q: query });
        if (versionId) params.set("v", versionId);
        const res = await fetch(
          `${BASE_PATH}/api/production/${productionId}/script/block-search?${params.toString()}`
        );
        const data = await res.json() as { results?: ScriptBlockSearchResult[] };
        return (data.results ?? []).map(r => ({
          // url (cue results) stored in id slot with leading "/"; else blockId
          id: r.url ?? r.blockId,
          label: r.label,
          secondary: r.description,
        }));
      } catch {
        return [];
      }
    },
    renderItem: (item, active) => (
      <span className="flex items-baseline gap-2">
        <span className={`font-mono text-sm font-semibold ${active ? "text-amber-800" : "text-amber-600"}`}>
          #{item.label}
        </span>
        {item.secondary && (
          <span className="text-xs text-zinc-400 truncate max-w-[200px]">{item.secondary}</span>
        )}
      </span>
    ),
    format: (item) => {
      const href = item.id.startsWith("/")
        ? `${BASE_PATH}${item.id}`
        : `${BASE_PATH}/production/${productionId}/script#block-${item.id}`;
      return `[#${item.label}](${href}${item.secondary ? ` "${item.secondary.replace(/"/g, "'")}"` : ""})`;
    },
    toNode: (item) => {
      const href = item.id.startsWith("/")
        ? `${BASE_PATH}${item.id}`
        : `${BASE_PATH}/production/${productionId}/script#block-${item.id}`;
      return { id: item.id, label: item.label, href, title: item.secondary ?? null };
    },
  };
}

// ── TipTap mention extensions ─────────────────────────────────────────────────

// Script mention — adds href and title attrs on top of standard Mention attrs
const ScriptMentionExt = Mention.extend({
  name: "scriptMention",
  addKeyboardShortcuts() {
    return {
      Backspace: () =>
        this.editor.commands.command(({ tr, state }) => {
          let handled = false;
          const { selection } = state;
          if (!selection.empty) return false;
          state.doc.nodesBetween(selection.anchor - 1, selection.anchor, (node, pos) => {
            if (node.type.name === this.name) {
              handled = true;
              tr.insertText("#", pos, pos + node.nodeSize);
              return false;
            }
          });
          return handled;
        }),
    };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      href: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-href"),
        renderHTML: (attrs) => (attrs.href ? { "data-href": attrs.href } : {}),
      },
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-title") || null,
        renderHTML: (attrs) => (attrs.title ? { "data-title": attrs.title } : {}),
      },
    };
  },
});

// At-mention — standard Mention attrs (id, label) are enough
const AtMentionExt = Mention.extend({ name: "atMention" });

// ── Text serialisation ────────────────────────────────────────────────────────

function serializeDoc(editor: ReturnType<typeof useEditor>): string {
  if (!editor) return "";
  return editor.getText({
    blockSeparator: "\n",
    textSerializers: {
      hardBreak: () => "\n",
      scriptMention: ({ node }) => {
        const { label, href, title } = node.attrs;
        return `[#${label}](${href}${title ? ` "${title}"` : ""})`;
      },
      atMention: ({ node }) => `@${node.attrs.label}`,
    },
  });
}

// ── Text → TipTap JSON ────────────────────────────────────────────────────────

function parseLine(line: string): JSONContent[] {
  const SCRIPT = String.raw`\[#[^\]\n]*\]\([^\s)"]+(?:\s+"[^"]*")?\)`;
  const AT = String.raw`@[\w一-鿿]+`;
  const parts = line.split(new RegExp(`(${SCRIPT}|${AT})`));
  const nodes: JSONContent[] = [];
  for (const part of parts) {
    if (!part) continue;
    const sm = part.match(/^\[#([^\]]*)\]\(([^\s)"]+)(?:\s+"([^"]*)")?\)$/);
    if (sm) {
      const [, label, href, title] = sm;
      nodes.push({
        type: "scriptMention",
        attrs: { id: href.split("#block-").pop() ?? href, label, href, title: title ?? null },
      });
      continue;
    }
    const am = part.match(/^@([\w一-鿿]+)$/);
    if (am) {
      nodes.push({ type: "atMention", attrs: { id: am[1], label: am[1] } });
      continue;
    }
    nodes.push({ type: "text", text: part });
  }
  return nodes;
}

function parseToDoc(text: string): JSONContent {
  const lines = text.split("\n");
  return {
    type: "doc",
    content: lines.map((line) => {
      const inline = parseLine(line);
      return { type: "paragraph", content: inline.length ? inline : undefined };
    }),
  };
}

// ── Drop state ────────────────────────────────────────────────────────────────

type DropState = {
  trigger: string;
  items: DropItem[];
  idx: number;
  clientRect: (() => DOMRect | null) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  command: (attrs: any) => void;
} | null;

// ── SmartTextarea ─────────────────────────────────────────────────────────────

export default function SmartTextarea({
  value,
  onChange,
  plugins = [],
  placeholder,
  rows = 3,
  className = "",
  onKeyDown,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  plugins?: DropPlugin[];
  placeholder?: string;
  rows?: number;
  className?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  autoFocus?: boolean;
}) {
  const [drop, setDrop] = useState<DropState>(null);
  const dropRef = useRef<DropState>(null);
  const pluginsRef = useRef(plugins);
  const lastEmittedRef = useRef(value);

  // Keep refs in sync after each render (never during render)
  useEffect(() => { dropRef.current = drop; });
  useEffect(() => { pluginsRef.current = plugins; });

  // Computed once at mount — plugin set doesn't change at runtime for a given instance
  const hasHashPlugin = plugins.some((p) => p.trigger === "#");
  const hasAtPlugin = plugins.some((p) => p.trigger === "@");

  // Stable suggestion handlers — created once, read from refs at call time
  const suggHandlers = useRef({
    onStart(props: SuggestionProps<DropItem>, trigger: string) {
      setDrop({
        trigger,
        items: props.items as DropItem[],
        idx: 0,
        clientRect: props.clientRect ?? null,
        command: props.command,
      });
    },
    onUpdate(props: SuggestionProps<DropItem>) {
      setDrop((prev) =>
        prev
          ? { ...prev, items: props.items as DropItem[], clientRect: props.clientRect ?? null, command: props.command }
          : null,
      );
    },
    onExit() { setDrop(null); },
    onKeyDown({ event }: SuggestionKeyDownProps): boolean {
      const d = dropRef.current;
      if (!d) return false;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setDrop((p) => (p ? { ...p, idx: Math.min(p.idx + 1, p.items.length - 1) } : null));
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setDrop((p) => (p ? { ...p, idx: Math.max(p.idx - 1, 0) } : null));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = d.items[d.idx];
        if (item) {
          const plugin = pluginsRef.current.find((p) => p.trigger === d.trigger);
          d.command(plugin?.toNode ? plugin.toNode(item) : { id: item.id, label: item.label });
          plugin?.onPick?.(item);
          setDrop(null);
        }
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDrop(null);
        return true;
      }
      return false;
    },
  });

  // makeSuggestion and the useMemo below capture refs in async TipTap callbacks —
  // .current is never read during React render, only when TipTap fires the callbacks.
  /* eslint-disable react-hooks/refs */

  function makeSuggestion(trigger: string, enabled: boolean) {
    return {
      char: trigger,
      pluginKey: new PluginKey(`${trigger === "#" ? "script" : "at"}Mention`),
      allow: () => enabled,
      items: ({ query }: { query: string }) =>
        pluginsRef.current.find((p) => p.trigger === trigger)?.search(query) ?? [],
      render: () => ({
        onStart: (props: SuggestionProps<DropItem>) =>
          suggHandlers.current.onStart(props, trigger),
        onUpdate: (props: SuggestionProps<DropItem>) =>
          suggHandlers.current.onUpdate(props),
        onExit: () => suggHandlers.current.onExit(),
        onKeyDown: (props: SuggestionKeyDownProps) =>
          suggHandlers.current.onKeyDown(props),
      }),
    };
  }

  const extensions = useMemo(() => [
    StarterKit.configure({
      bold: false, italic: false, strike: false, code: false, codeBlock: false,
      heading: false, blockquote: false, bulletList: false, orderedList: false,
      listItem: false, horizontalRule: false,
    }),
    Placeholder.configure({ placeholder }),
    ScriptMentionExt.configure({
      renderText: ({ node }) => {
        const { label, href, title } = node.attrs;
        return `[#${label}](${href}${title ? ` "${title}"` : ""})`;
      },
      renderHTML: ({ node }) => [
        "span",
        {
          "data-type": "scriptMention",
          "data-id": node.attrs.id,
          "data-label": node.attrs.label,
          "data-href": node.attrs.href ?? "",
          "data-title": node.attrs.title ?? "",
          style:
            "display:inline-flex;align-items:center;padding:0 4px;border-radius:4px;" +
            "font-family:monospace;font-size:11px;font-weight:600;" +
            "background:#fffbeb;color:#b45309;border:1px solid #fde68a;cursor:default;",
        },
        `#${node.attrs.label}`,
      ],
      suggestion: makeSuggestion("#", hasHashPlugin),
    }),
    AtMentionExt.configure({
      renderText: ({ node }) => `@${node.attrs.label}`,
      renderHTML: ({ node }) => [
        "span",
        {
          "data-type": "atMention",
          "data-id": node.attrs.id,
          "data-label": node.attrs.label,
          style: "font-weight:500;color:#3b82f6;",
        },
        `@${node.attrs.label}`,
      ],
      suggestion: makeSuggestion("@", hasAtPlugin),
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);
  /* eslint-enable react-hooks/refs */

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: parseToDoc(value),
    autofocus: autoFocus,
    editorProps: {
      attributes: {
        class: "outline-none smart-textarea-content",
        style: `min-height:${rows * 1.375}em`,
      },
      handleKeyDown: (_view, event) => {
        if (!dropRef.current) {
          onKeyDown?.(event);
          return event.defaultPrevented;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const text = serializeDoc(editor);
      if (text !== lastEmittedRef.current) {
        lastEmittedRef.current = text;
        onChange(text);
      }
    },
  });

  // Sync external value → editor (e.g. form reset, external state change)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editor.commands.setContent(parseToDoc(value), { emitUpdate: false });
  }, [value, editor]);

  const rect = drop?.clientRect?.();

  return (
    <>
      <div
        className={`${className} focus-within:border-zinc-400`}
        onClick={() => editor?.commands.focus()}
      >
        <EditorContent editor={editor} />
      </div>

      {drop && rect && typeof document !== "undefined" &&
        createPortal(
          <div
            style={{ position: "fixed", left: rect.left, top: rect.bottom + 4, zIndex: 9999 }}
            className="bg-white rounded-xl shadow-lg border border-zinc-100 py-1 min-w-[160px] max-w-[360px] max-h-64 overflow-y-auto"
          >
            {drop.items.length === 0 ? (
              <p className="px-3 py-2 text-sm text-zinc-400">
                {plugins.find((p) => p.trigger === drop.trigger)?.emptyLabel ?? "无匹配"}
              </p>
            ) : (
              drop.items.map((item, i) => {
                const plugin = plugins.find((p) => p.trigger === drop.trigger);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      drop.command(plugin?.toNode ? plugin.toNode(item) : { id: item.id, label: item.label });
                      plugin?.onPick?.(item);
                      setDrop(null);
                    }}
                    className={`w-full text-left px-3 py-2 ${
                      i === drop.idx ? "bg-amber-50" : "hover:bg-zinc-50"
                    }`}
                  >
                    {plugin?.renderItem(item, i === drop.idx)}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
