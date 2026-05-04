"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { match as pinyinMatch } from "pinyin-pro";
import { createPortal } from "react-dom";
import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { MentionMember } from "./MentionTextarea";
import { BASE_PATH } from "@/lib/base-path";
import type { MentionSearchResult } from "@/lib/mention-types";
import {
  encodeMentionHref, decodeMentionHref, CM_HREF_PREFIX,
  type ContentMentionAttrs,
} from "@/lib/mention-types";

// ─── Toolbar ──────────────────────────────────────────────────────────────────

type TiptapEditor = ReturnType<typeof useEditor>;

function ToolbarBtn({
  onClick, active, title, children,
}: { onClick: () => void; active?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
      className={`px-2 py-1 rounded text-sm font-medium transition-colors ${
        active
          ? "bg-zinc-800 text-white"
          : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
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
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")} title="粗体 (⌘B)">
        <strong>B</strong>
      </ToolbarBtn>
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")} title="斜体 (⌘I)">
        <em>I</em>
      </ToolbarBtn>
      <span className="w-px bg-zinc-200 mx-1 self-stretch" />
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })} title="二级标题">
        H2
      </ToolbarBtn>
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })} title="三级标题">
        H3
      </ToolbarBtn>
      <span className="w-px bg-zinc-200 mx-1 self-stretch" />
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")} title="无序列表">
        ≡
      </ToolbarBtn>
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")} title="有序列表">
        1.
      </ToolbarBtn>
      <span className="w-px bg-zinc-200 mx-1 self-stretch" />
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")} title="引用">
        "
      </ToolbarBtn>
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive("code")} title="行内代码">
        {"</>"}
      </ToolbarBtn>
      <ToolbarBtn
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive("codeBlock")} title="代码块">
        {"{ }"}
      </ToolbarBtn>
    </div>
  );
}

// ─── Mention dropdown (people @) ──────────────────────────────────────────────

type SuggestionState = {
  items: MentionMember[];
  idx: number;
  rect: DOMRect;
  command: (m: MentionMember) => void;
} | null;

// ─── Content-ref dropdown (#) ─────────────────────────────────────────────────

type ContentSuggState = {
  items: MentionSearchResult[];
  idx: number;
  rect: DOMRect;
  command: (r: MentionSearchResult) => void;
} | null;

// ─── Editor ──────────────────────────────────────────────────────────────────

export default function MarkdownEditor({
  content,
  onChange = () => {},
  onMentionsChange = () => {},
  members = [],
  productionId,
  versionId,
  placeholder = "写内容…",
  minHeight = 200,
  readOnly = false,
}: {
  content: string;
  onChange?: (md: string) => void;
  onMentionsChange?: (m: MentionMember[]) => void;
  members?: MentionMember[];
  productionId?: string;
  versionId?: string | null;
  placeholder?: string;
  minHeight?: number;
  readOnly?: boolean;
}) {
  const [sugg, setSugg] = useState<SuggestionState>(null);
  const [contentSugg, setContentSugg] = useState<ContentSuggState>(null);

  const membersRef = useRef(members);
  membersRef.current = members;
  const productionIdRef = useRef(productionId);
  productionIdRef.current = productionId;
  const versionIdRef = useRef(versionId);
  versionIdRef.current = versionId;
  const suggRef = useRef<SuggestionState>(null);
  suggRef.current = sugg;
  const setSuggRef = useRef(setSugg);
  setSuggRef.current = setSugg;
  const contentSuggRef = useRef<ContentSuggState>(null);
  contentSuggRef.current = contentSugg;
  const setContentSuggRef = useRef(setContentSugg);
  setContentSuggRef.current = setContentSugg;

  const keyHandlerRef = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const contentKeyHandlerRef = useRef<((e: KeyboardEvent) => boolean) | null>(null);

  const extensions = useMemo(() => {
    const exts = [
      StarterKit,
      Markdown.configure({ transformCopiedText: true }),
      Placeholder.configure({ placeholder }),
      Mention.configure({
        HTMLAttributes: { class: "text-blue-500 font-medium" },
        suggestion: {
          char: "@",
          items: ({ query }: { query: string }) => {
            const m = membersRef.current;
            if (!query) return m.slice(0, 6);
            return m.filter(x =>
              x.name.includes(query) || pinyinMatch(x.name, query.toLowerCase()) != null
            ).slice(0, 6);
          },
          render: () => ({
            onStart: (props: { items: MentionMember[]; clientRect?: (() => DOMRect | null) | null; command: (attrs: { id: string; label: string }) => void }) => {
              const rect = props.clientRect?.();
              if (!rect) return;
              setSuggRef.current({
                items: props.items,
                idx: 0,
                rect,
                command: (m) => props.command({ id: m.openId, label: m.name }),
              });
            },
            onUpdate: (props: { items: MentionMember[]; clientRect?: (() => DOMRect | null) | null; command: (attrs: { id: string; label: string }) => void }) => {
              const rect = props.clientRect?.();
              setSuggRef.current(prev => prev && rect ? {
                ...prev,
                items: props.items,
                rect,
                command: (m) => props.command({ id: m.openId, label: m.name }),
              } : null);
            },
            onKeyDown: ({ event }: { event: KeyboardEvent }) => {
              return keyHandlerRef.current?.(event) ?? false;
            },
            onExit: () => setSuggRef.current(null),
          }),
        },
      }),
    ];

    if (productionIdRef.current) {
      const ContentMention = Mention.extend({
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
                const displayLabel = label ?? kind;
                state.write(`[#${displayLabel}](${href})`);
              },
            },
          };
        },
      });

      exts.push(
        ContentMention.configure({
          HTMLAttributes: {
            class: "inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 text-amber-700 border border-amber-200 cursor-default",
          },
          renderHTML({ options, node }) {
            const label = node.attrs.label ?? node.attrs.kind;
            return [
              "span",
              {
                ...options.HTMLAttributes,
                "data-content-mention": node.attrs.id,
                "data-id": node.attrs.id,
                "data-kind": node.attrs.kind,
                "data-display-mode": node.attrs.displayMode ?? "",
                "data-aux": node.attrs.aux ?? "",
              },
              `#${label}`,
            ];
          },
          suggestion: {
            char: "#",
            allowSpaces: false,
            items: async ({ query }: { query: string }) => {
              const pid = productionIdRef.current;
              const vid = versionIdRef.current;
              if (!pid || !query) return [];
              try {
                const params = new URLSearchParams({ q: query });
                if (vid) params.set("v", vid);
                const res = await fetch(
                  `${BASE_PATH}/api/production/${pid}/script/block-search?${params.toString()}`
                );
                const data = await res.json() as { results?: MentionSearchResult[] };
                return data.results ?? [];
              } catch {
                return [];
              }
            },
            render: () => ({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onStart: (props: any) => {
                const rect = props.clientRect?.();
                if (!rect) return;
                setContentSuggRef.current({
                  items: props.items as MentionSearchResult[],
                  idx: 0,
                  rect,
                  command: (r) => props.command({
                    kind: r.kind,
                    displayMode: r.displayMode ?? null,
                    id: r.id,
                    aux: r.aux ?? null,
                    versionId: null,
                    label: r.displayLabel.replace(/^#/, ""),
                  }),
                });
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onUpdate: (props: any) => {
                const rect = props.clientRect?.();
                setContentSuggRef.current(prev => prev && rect ? {
                  ...prev,
                  items: props.items as MentionSearchResult[],
                  rect,
                  command: (r) => props.command({
                    kind: r.kind,
                    displayMode: r.displayMode ?? null,
                    id: r.id,
                    aux: r.aux ?? null,
                    versionId: null,
                    label: r.displayLabel.replace(/^#/, ""),
                  }),
                } : null);
              },
              onKeyDown: ({ event }: { event: KeyboardEvent }) => {
                return contentKeyHandlerRef.current?.(event) ?? false;
              },
              onExit: () => setContentSuggRef.current(null),
            }),
          },
        })
      );
    }

    return exts;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions,
    content,
    editorProps: {
      attributes: {
        class: "prose prose-zinc max-w-none focus:outline-none px-3 py-2",
        style: readOnly ? "" : `min-height:${minHeight}px`,
      },
    },
    onUpdate: ({ editor }) => {
      if (readOnly) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md = (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
      onChange(md);

      const mentioned: MentionMember[] = [];
      const seen = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function traverse(node: any) {
        if (node.type === "mention" && node.attrs?.id && !seen.has(node.attrs.id)) {
          seen.add(node.attrs.id);
          mentioned.push({ openId: node.attrs.id, name: node.attrs.label ?? node.attrs.id });
        }
        node.content?.forEach(traverse);
      }
      editor.getJSON().content?.forEach(traverse);
      onMentionsChange(mentioned);
    },
  });

  const handleSuggKey = useCallback((event: KeyboardEvent): boolean => {
    const s = suggRef.current;
    if (!s || s.items.length === 0) return false;
    if (event.key === "ArrowDown") {
      setSuggRef.current(prev => prev ? { ...prev, idx: Math.min(prev.idx + 1, prev.items.length - 1) } : null);
      return true;
    }
    if (event.key === "ArrowUp") {
      setSuggRef.current(prev => prev ? { ...prev, idx: Math.max(prev.idx - 1, 0) } : null);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const item = s.items[s.idx];
      if (item) { s.command(item); setSuggRef.current(null); }
      return true;
    }
    if (event.key === "Escape") { setSuggRef.current(null); return true; }
    return false;
  }, []);

  const handleContentSuggKey = useCallback((event: KeyboardEvent): boolean => {
    const s = contentSuggRef.current;
    if (!s || s.items.length === 0) return false;
    if (event.key === "ArrowDown") {
      setContentSuggRef.current(prev => prev ? { ...prev, idx: Math.min(prev.idx + 1, prev.items.length - 1) } : null);
      return true;
    }
    if (event.key === "ArrowUp") {
      setContentSuggRef.current(prev => prev ? { ...prev, idx: Math.max(prev.idx - 1, 0) } : null);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const item = s.items[s.idx];
      if (item) { s.command(item); setContentSuggRef.current(null); }
      return true;
    }
    if (event.key === "Escape") { setContentSuggRef.current(null); return true; }
    return false;
  }, []);

  useEffect(() => { keyHandlerRef.current = handleSuggKey; }, [handleSuggKey]);
  useEffect(() => { contentKeyHandlerRef.current = handleContentSuggKey; }, [handleContentSuggKey]);

  return (
    <div
      className={readOnly
        ? "overflow-hidden"
        : "rounded-lg border border-zinc-200 focus-within:border-zinc-400 overflow-hidden bg-white"}
    >
      {!readOnly && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />

      {/* People mention dropdown */}
      {sugg && typeof document !== "undefined" && createPortal(
        <div
          style={{ position: "fixed", left: sugg.rect.left, top: sugg.rect.bottom + 4, zIndex: 9999 }}
          className="bg-white rounded-xl shadow-lg border border-zinc-100 py-1 min-w-[140px] max-h-48 overflow-y-auto"
        >
          {sugg.items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-zinc-400">无匹配成员</p>
          ) : sugg.items.map((m, i) => (
            <button
              key={m.openId}
              onMouseDown={e => { e.preventDefault(); sugg.command(m); setSugg(null); }}
              className={`w-full text-left px-3 py-2 text-sm ${
                i === sugg.idx ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {m.name}
            </button>
          ))}
        </div>,
        document.body,
      )}

      {/* Content mention dropdown */}
      {contentSugg && typeof document !== "undefined" && createPortal(
        <div
          style={{ position: "fixed", left: contentSugg.rect.left, top: contentSugg.rect.bottom + 4, zIndex: 9999 }}
          className="bg-white rounded-xl shadow-lg border border-zinc-100 py-1 min-w-[220px] max-w-[360px] max-h-64 overflow-y-auto"
        >
          {contentSugg.items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-zinc-400">无匹配内容</p>
          ) : contentSugg.items.map((r, i) => (
            <button
              key={`${r.kind}:${r.id}:${i}`}
              onMouseDown={e => { e.preventDefault(); contentSugg.command(r); setContentSugg(null); }}
              className={`w-full text-left px-3 py-2 ${
                i === contentSugg.idx ? "bg-amber-50" : "hover:bg-zinc-50"
              }`}
            >
              <span className="font-mono text-sm font-semibold text-amber-700">{r.displayLabel}</span>
              {r.description && (
                <span className="ml-2 text-xs text-zinc-400 truncate max-w-[200px] inline-block align-bottom overflow-hidden">{r.description}</span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
