"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import Placeholder from "@tiptap/extension-placeholder";
import { Mention } from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { match as pinyinMatch } from "pinyin-pro";
import { BASE_PATH } from "@/lib/base-path";
import type { JSONContent } from "@tiptap/react";
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { MentionSearchResult } from "@/lib/mention-types";
import {
  serializeMention, deserializeMention,
  encodeMentionHref, decodeMentionHref, CM_HREF_PREFIX,
  type ContentMentionAttrs,
} from "@/lib/mention-types";

// ── Public types ──────────────────────────────────────────────────────────────

export type MentionMember = { openId: string; name: string; avatarUrl?: string | null };

export type DropItem = { id: string; label: string; secondary?: string; data?: unknown };

export type DropPlugin = {
  trigger: string;
  allowSpaces?: boolean;
  emptyLabel?: string;
  search: (query: string) => Promise<DropItem[]> | DropItem[];
  renderItem: (item: DropItem, active: boolean) => React.ReactNode;
  format: (item: DropItem) => string;
  onPick?: (item: DropItem) => void;
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

// ── Factory: #content ref ─────────────────────────────────────────────────────

export function contentRefPlugin(productionId: string, versionId?: string | null): DropPlugin {
  return {
    trigger: "#",
    emptyLabel: versionId === null ? "请先为活动选择版本" : "无匹配内容",
    search: async (query) => {
      if (!query || versionId === null) return [];
      try {
        const params = new URLSearchParams({ q: query });
        if (versionId) params.set("v", versionId);
        const res = await fetch(
          `${BASE_PATH}/api/production/${productionId}/script/block-search?${params.toString()}`
        );
        const data = await res.json() as { results?: MentionSearchResult[] };
        return (data.results ?? []).map(r => ({
          id: `${r.kind}:${r.id}:${r.aux ?? ""}:${r.displayMode ?? ""}`,
          label: r.displayLabel.startsWith("#") ? r.displayLabel.slice(1) : r.displayLabel,
          secondary: r.description,
          data: r,
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
      const r = item.data as MentionSearchResult | undefined;
      if (!r) return `#${item.label}`;
      return serializeMention({ kind: r.kind, displayMode: r.displayMode ?? null, id: r.id, aux: r.aux ?? null, versionId: null });
    },
    toNode: (item) => {
      const r = item.data as MentionSearchResult | undefined;
      if (!r) return { kind: "page", displayMode: null, id: item.id, aux: null, versionId: null, label: item.label };
      return { kind: r.kind, displayMode: r.displayMode ?? null, id: r.id, aux: r.aux ?? null, versionId: r.versionId ?? null, label: item.label } satisfies ContentMentionAttrs & { label: string };
    },
  };
}

export { contentRefPlugin as scriptRefDropPlugin };

// ── Toolbar (markdown mode only) ──────────────────────────────────────────────

type TiptapEditor = ReturnType<typeof useEditor>;

function ToolbarBtn({ onClick, active, title, children }: { onClick: () => void; active?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
      className={`px-2 py-1 rounded text-sm font-medium transition-colors ${
        active ? "bg-zinc-800 text-white" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: TiptapEditor | null }) {
  if (!editor) return null;
  return (
    <div className="flex flex-wrap gap-0.5 px-2 py-1.5 border-b border-zinc-100">
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="粗体 (⌘B)"><strong>B</strong></ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="斜体 (⌘I)"><em>I</em></ToolbarBtn>
      <span className="w-px bg-zinc-200 mx-1 self-stretch" />
      <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} title="二级标题">H2</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} title="三级标题">H3</ToolbarBtn>
      <span className="w-px bg-zinc-200 mx-1 self-stretch" />
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="无序列表">≡</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="有序列表">1.</ToolbarBtn>
      <span className="w-px bg-zinc-200 mx-1 self-stretch" />
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} title="引用">"</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive("code")} title="行内代码">{"</>"}</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive("codeBlock")} title="代码块">{"{ }"}</ToolbarBtn>
    </div>
  );
}

// ── TipTap extensions ─────────────────────────────────────────────────────────

// Content mention — plain text mode: serialises as [#kind:id] tokens
const PlainContentMentionExt = Mention.extend({
  name: "contentMention",
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
      kind: { default: "scene" },
      displayMode: { default: null },
      id: { default: "" },
      aux: { default: null },
      versionId: { default: null },
      label: { default: null },
    };
  },
});

// Content mention — markdown mode: serialises as [#label](cm://...) links
const MarkdownContentMentionExt = Mention.extend({
  name: "contentMention",
  addAttributes() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.parent as any)?.(),
      kind: { default: "scene" },
      displayMode: { default: null },
      aux: { default: null },
      versionId: { default: null },
      label: { default: null },
    };
  },
  parseHTML() {
    return [
      { tag: "span[data-content-mention]" },
      {
        tag: "a",
        priority: 1001,
        getAttrs(el) {
          if (typeof el === "string") return false;
          const href = el.getAttribute("href") ?? "";
          if (!href.startsWith(CM_HREF_PREFIX)) return false;
          const attrs = decodeMentionHref(href);
          if (!attrs) return false;
          const label = (el.textContent ?? "").replace(/^#/, "");
          return { ...attrs, label };
        },
      },
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: ContentMentionAttrs & { label?: string } }) {
          const { kind, displayMode, id, aux, versionId, label } = node.attrs;
          const href = encodeMentionHref({ kind, displayMode, id, aux, versionId });
          state.write(`[#${label ?? kind}](${href})`);
        },
      },
    };
  },
});

// @ mention — works in both modes; adds markdown serialization for markdown mode
const AtMentionExt = Mention.extend({
  name: "atMention",
  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { label: string } }) {
          state.write(`@${node.attrs.label}`);
        },
      },
    };
  },
});

// ── Plain-text serialisation (non-markdown mode) ───────────────────────────────

function serializeDoc(editor: ReturnType<typeof useEditor>): string {
  if (!editor) return "";
  return editor.getText({
    blockSeparator: "\n",
    textSerializers: {
      hardBreak: () => "\n",
      contentMention: ({ node }) => {
        const { kind, displayMode, id, aux, versionId } = node.attrs as ContentMentionAttrs;
        return serializeMention({ kind, displayMode, id, aux, versionId });
      },
      atMention: ({ node }) => `@${node.attrs.label}`,
    },
  });
}

function parseLine(line: string): JSONContent[] {
  const CMENTION = String.raw`\[#[^\]\n]*\](?:\([^\s)"]+(?:\s+"[^"]*")?\))?`;
  const AT = String.raw`@[\w一-鿿]+`;
  const parts = line.split(new RegExp(`(${CMENTION}|${AT})`));
  const nodes: JSONContent[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (/^\[#[^\]]+\]$/.test(part)) {
      const attrs = deserializeMention(part);
      if (attrs) { nodes.push({ type: "contentMention", attrs: { ...attrs, label: null } }); continue; }
    }
    const legacyM = part.match(/^\[#([^\]]*)\]\(([^\s)"]+)(?:\s+"([^"]*)")?\)$/);
    if (legacyM) {
      const [, label, href] = legacyM;
      const blockIdM = href.match(/#block-([^"?\s]+)/);
      if (blockIdM) {
        nodes.push({ type: "contentMention", attrs: { kind: "block", displayMode: "scene", id: blockIdM[1], aux: null, versionId: null, label } });
        continue;
      }
      nodes.push({ type: "text", text: `#${label}` });
      continue;
    }
    const am = part.match(/^@([\w一-鿿]+)$/);
    if (am) { nodes.push({ type: "atMention", attrs: { id: am[1], label: am[1] } }); continue; }
    nodes.push({ type: "text", text: part });
  }
  return nodes;
}

function parseToDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => {
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

// ── Props ─────────────────────────────────────────────────────────────────────

export interface SmartTextareaProps {
  value: string;
  onChange: (v: string) => void;
  /** Enable @ person mentions */
  memberMention?: { members: MentionMember[]; onMentionsChange?: (m: MentionMember[]) => void };
  /** Enable # content/script mentions */
  contentMention?: { productionId: string; versionId?: string | null };
  /** Enable markdown toolbar and serialisation */
  markdown?: boolean;
  /** Extra custom-trigger plugins (escape hatch) */
  plugins?: DropPlugin[];
  placeholder?: string;
  rows?: number;
  minHeight?: number;
  className?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  autoFocus?: boolean;
  readOnly?: boolean;
}

// ── SmartTextarea ─────────────────────────────────────────────────────────────

export default function SmartTextarea({
  value,
  onChange,
  memberMention,
  contentMention,
  markdown = false,
  plugins: extraPlugins = [],
  placeholder,
  rows = 3,
  minHeight,
  className = "",
  onKeyDown,
  autoFocus,
  readOnly = false,
}: SmartTextareaProps) {
  const [drop, setDrop] = useState<DropState>(null);
  const dropRef = useRef<DropState>(null);
  const lastEmittedRef = useRef(value);

  // Keep mutable refs so suggestion callbacks always see latest values
  const memberMentionRef = useRef(memberMention);
  memberMentionRef.current = memberMention;
  const contentMentionRef = useRef(contentMention);
  contentMentionRef.current = contentMention;

  useEffect(() => { dropRef.current = drop; });

  // Build the full plugin list: derived from feature flags + extras
  const allPluginsRef = useRef<DropPlugin[]>([]);

  // Rebuild on each render (plugins are lightweight objects)
  const derivedPlugins: DropPlugin[] = [];
  if (memberMention) {
    derivedPlugins.push(memberDropPlugin(memberMention.members));
  }
  if (contentMention) {
    derivedPlugins.push(contentRefPlugin(contentMention.productionId, contentMention.versionId));
  }
  const allPlugins = [...derivedPlugins, ...extraPlugins];
  allPluginsRef.current = allPlugins;

  const hasHashPlugin = allPlugins.some(p => p.trigger === "#");
  const hasAtPlugin = allPlugins.some(p => p.trigger === "@");

  const suggHandlers = useRef({
    onStart(props: SuggestionProps<DropItem>, trigger: string) {
      setDrop({ trigger, items: props.items as DropItem[], idx: 0, clientRect: props.clientRect ?? null, command: props.command });
    },
    onUpdate(props: SuggestionProps<DropItem>) {
      setDrop(prev => prev
        ? { ...prev, items: props.items as DropItem[], clientRect: props.clientRect ?? null, command: props.command }
        : null);
    },
    onExit() { setDrop(null); },
    onKeyDown({ event }: SuggestionKeyDownProps): boolean {
      const d = dropRef.current;
      if (!d) return false;
      if (event.key === "ArrowDown") { event.preventDefault(); setDrop(p => p ? { ...p, idx: Math.min(p.idx + 1, p.items.length - 1) } : null); return true; }
      if (event.key === "ArrowUp") { event.preventDefault(); setDrop(p => p ? { ...p, idx: Math.max(p.idx - 1, 0) } : null); return true; }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = d.items[d.idx];
        if (item) {
          const plugin = allPluginsRef.current.find(p => p.trigger === d.trigger);
          d.command(plugin?.toNode ? plugin.toNode(item) : { id: item.id, label: item.label });
          plugin?.onPick?.(item);
          setDrop(null);
        }
        return true;
      }
      if (event.key === "Escape") { event.preventDefault(); setDrop(null); return true; }
      return false;
    },
  });

  function makeSuggestion(trigger: string, enabled: boolean) {
    return {
      char: trigger,
      pluginKey: new PluginKey(trigger === "#" ? "contentMention" : "atMention"),
      allow: () => enabled,
      items: ({ query }: { query: string }) =>
        allPluginsRef.current.find(p => p.trigger === trigger)?.search(query) ?? [],
      render: () => ({
        onStart: (props: SuggestionProps<DropItem>) => suggHandlers.current.onStart(props, trigger),
        onUpdate: (props: SuggestionProps<DropItem>) => suggHandlers.current.onUpdate(props),
        onExit: () => suggHandlers.current.onExit(),
        onKeyDown: (props: SuggestionKeyDownProps) => suggHandlers.current.onKeyDown(props),
      }),
    };
  }

  const ContentMentionExt = markdown ? MarkdownContentMentionExt : PlainContentMentionExt;

  const extensions = useMemo(() => {
    const base = markdown
      ? StarterKit
      : StarterKit.configure({
          bold: false, italic: false, strike: false, code: false, codeBlock: false,
          heading: false, blockquote: false, bulletList: false, orderedList: false,
          listItem: false, horizontalRule: false,
        });

    const contentMentionCfg = ContentMentionExt.configure({
      renderText: ({ node }) => {
        const { kind, displayMode, id, aux, versionId } = node.attrs as ContentMentionAttrs;
        return serializeMention({ kind, displayMode, id, aux, versionId });
      },
      renderHTML: ({ node }) => {
        const { kind, displayMode, id, aux, versionId, label } = node.attrs;
        return [
          "span",
          {
            "data-type": "contentMention",
            "data-content-mention": id,
            "data-kind": kind,
            "data-display-mode": displayMode ?? "",
            "data-id": id,
            "data-aux": aux ?? "",
            "data-version-id": versionId ?? "",
            class: "inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 text-amber-700 border border-amber-200 cursor-default",
          },
          `#${label ?? kind}`,
        ];
      },
      suggestion: makeSuggestion("#", hasHashPlugin),
    });

    const atMentionCfg = AtMentionExt.configure({
      renderText: ({ node }) => `@${node.attrs.label}`,
      renderHTML: ({ node }) => [
        "span",
        { "data-type": "atMention", "data-id": node.attrs.id, "data-label": node.attrs.label, style: "font-weight:500;color:#3b82f6;" },
        `@${node.attrs.label}`,
      ],
      suggestion: makeSuggestion("@", hasAtPlugin),
    });

    const commonExts = [
      Placeholder.configure({ placeholder }),
      contentMentionCfg,
      atMentionCfg,
    ];

    return markdown
      ? [base, Markdown.configure({ transformCopiedText: true }), ...commonExts]
      : [base, ...commonExts];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown]);

  const editorMinHeight = minHeight != null
    ? `${minHeight}px`
    : `${rows * 1.375}em`;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions,
    content: markdown ? value : parseToDoc(value),
    autofocus: autoFocus,
    editorProps: {
      attributes: {
        class: markdown
          ? "prose prose-zinc max-w-none focus:outline-none px-3 py-2 smart-textarea-content"
          : "outline-none smart-textarea-content",
        style: readOnly ? "" : `min-height:${editorMinHeight}`,
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
      if (readOnly) return;
      let text: string;
      if (markdown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        text = (editor.storage as any).markdown.getMarkdown();
      } else {
        text = serializeDoc(editor);
      }
      if (text !== lastEmittedRef.current) {
        lastEmittedRef.current = text;
        onChange(text);
      }
      // Emit the current set of @ mentioned members
      if (memberMentionRef.current?.onMentionsChange) {
        const mentioned: MentionMember[] = [];
        const seen = new Set<string>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function traverse(node: any) {
          if ((node.type === "atMention" || node.type === "mention") && node.attrs?.id && !seen.has(node.attrs.id)) {
            seen.add(node.attrs.id);
            mentioned.push({ openId: node.attrs.id, name: node.attrs.label ?? node.attrs.id });
          }
          node.content?.forEach(traverse);
        }
        editor.getJSON().content?.forEach(traverse);
        memberMentionRef.current.onMentionsChange(mentioned);
      }
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    const newContent = markdown ? value : parseToDoc(value);
    editor.commands.setContent(newContent, { emitUpdate: false });
  }, [value, editor, markdown]);

  const rect = drop?.clientRect?.();

  const editorEl = (
    <>
      <EditorContent editor={editor} />
      {drop && rect && typeof document !== "undefined" &&
        createPortal(
          <div
            style={{ position: "fixed", left: rect.left, top: rect.bottom + 4, zIndex: 9999 }}
            className="bg-white rounded-xl shadow-lg border border-zinc-100 py-1 min-w-[160px] max-w-[360px] max-h-64 overflow-y-auto"
          >
            {drop.items.length === 0 ? (
              <p className="px-3 py-2 text-sm text-zinc-400">
                {allPlugins.find(p => p.trigger === drop.trigger)?.emptyLabel ?? "无匹配"}
              </p>
            ) : (
              drop.items.map((item, i) => {
                const plugin = allPlugins.find(p => p.trigger === drop.trigger);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseDown={e => {
                      e.preventDefault();
                      drop.command(plugin?.toNode ? plugin.toNode(item) : { id: item.id, label: item.label });
                      plugin?.onPick?.(item);
                      setDrop(null);
                    }}
                    className={`w-full text-left px-3 py-2 ${i === drop.idx ? "bg-amber-50" : "hover:bg-zinc-50"}`}
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

  if (markdown) {
    return (
      <div className={readOnly ? "overflow-hidden" : `rounded-lg border border-zinc-200 focus-within:border-zinc-400 overflow-hidden bg-white ${className}`}>
        {!readOnly && <Toolbar editor={editor} />}
        {editorEl}
      </div>
    );
  }

  return (
    <div className={`${className} focus-within:border-zinc-400`} onClick={() => editor?.commands.focus()}>
      {editorEl}
    </div>
  );
}
