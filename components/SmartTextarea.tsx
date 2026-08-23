"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import Placeholder from "@tiptap/extension-placeholder";
import { Mention } from "@tiptap/extension-mention";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Suggestion from "@tiptap/suggestion";
import { PluginKey, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { match as pinyinMatch } from "pinyin-pro";
import { BASE_PATH } from "@/lib/base-path";
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { MentionSearchResult } from "@/lib/mention-types";
import {
  encodeMentionHref, decodeMentionHref, CM_HREF_PREFIX,
  type ContentMentionAttrs,
} from "@/lib/mention-types";
import { parseToDoc, serializeAtMention, normalizeLegacyMentions } from "@/lib/mention-format";
import { isFeishuHtml, transformFeishuHtml } from "@/lib/feishu-paste";
import { Callout } from "@/lib/tiptap-callout";
import { WikiImage } from "@/lib/tiptap-wiki-image";
import { UploadPlaceholder, uploadPlaceholderKey, findUploadPlaceholder } from "@/lib/tiptap-upload-placeholder";
import { Column, ColumnGroup } from "@/lib/tiptap-columns";
export { normalizeLegacyMentions };
import { serializeMention } from "@/lib/mention-types";

// ── Public types ──────────────────────────────────────────────────────────────

export type MentionMember = { userId: string; name: string; avatarUrl?: string | null };

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
      return list.map(m => ({ id: m.userId, label: m.name }));
    },
    renderItem: (item) => <span className="text-sm">{item.label}</span>,
    format: (item) => `@${item.label}`,
    onPick: opts?.onPick ? (item) => opts.onPick!({ userId: item.id, name: item.label }) : undefined,
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

// ── Factory: [[wikilink ───────────────────────────────────────────────────────
// wiki 文档库 W4：`[[` 触发文档补全。落节点 kind='wiki' 的 contentMention 语义，
// markdown 序列化为 [#标题](/__cm__wiki:<id>)（存 id 不存标题——标题仅编辑期快照，
// 渲染端逐观看者经 mention-resolve 刷新，账本 §4.1）。

export function wikiLinkDropPlugin(productionId: string): DropPlugin {
  return {
    trigger: "[[",
    emptyLabel: "无匹配文档",
    search: async (query) => {
      if (!query) return [];
      try {
        const res = await fetch(
          `${BASE_PATH}/api/production/${productionId}/wiki?q=${encodeURIComponent(query)}`
        );
        const data = await res.json() as { results?: { id: string; title: string | null }[] };
        return (data.results ?? []).map(r => ({ id: r.id, label: r.title ?? "（无标题）" }));
      } catch {
        return [];
      }
    },
    renderItem: (item, active) => (
      <span className={`text-sm font-medium ${active ? "text-sky-800" : "text-sky-600"}`}>
        [[{item.label}]]
      </span>
    ),
    format: (item) => `[#${item.label}](${CM_HREF_PREFIX}wiki:${item.id})`,
    toNode: (item) => ({ id: item.id, label: item.label }),
  };
}

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
      <ToolbarBtn onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive("taskList")} title="任务列表">☑</ToolbarBtn>
      <span className="w-px bg-zinc-200 mx-1 self-stretch" />
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} title="引用">&ldquo;</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleWrap("callout").run()} active={editor.isActive("callout")} title="Callout 高亮块">💡</ToolbarBtn>
      <ToolbarBtn
        onClick={() => editor.chain().focus().insertContent({
          type: "columnGroup",
          content: [
            { type: "column", content: [{ type: "paragraph" }] },
            { type: "column", content: [{ type: "paragraph" }] },
          ],
        }).run()}
        active={editor.isActive("columnGroup")}
        title="两栏分栏"
      >◫</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} active={editor.isActive("table")} title="插入表格">⊞</ToolbarBtn>
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
          // wiki 链接文本恒为占位 "#"（见下方 serialize），textContent 剥完前缀后是
          // 空串——归一化成 null 而不是 ""，renderHTML 的 label ?? "文档" 才接得住
          const label = (el.textContent ?? "").replace(/^#/, "") || null;
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
          // wiki 标题不落存量文字——label 只是 chip 展示用的活刷新快照，写回正文
          // 只会留一段迟早过期的旧标题（同 wiki-link-syntax.ts 教模型的写法一致）
          const text = kind === "wiki" ? "#" : `#${label ?? kind}`;
          state.write(`[${text}](${href})`);
        },
      },
    };
  },
});

// [[wikilink 触发器（UI 修缮轮重构）：不再用独立 node——插入走已验证的
// contentMention(kind='wiki') 管线（序列化/重载/chip 渲染全部现成）。
// 独立 Suggestion 插件而非 Mention 内建：可设 allowedPrefixes=null——
// 默认只在空格/行首后触发，CJK 文本后直接敲 [[ 原本根本不弹补全（首版 bug 根因）。
const WikiLinkTrigger = Extension.create<{ suggestion: Record<string, unknown> }>({
  name: "wikiLinkTrigger",
  addOptions() {
    return { suggestion: {} };
  },
  addProseMirrorPlugins() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return [Suggestion({ editor: this.editor, ...(this.options.suggestion as any) })];
  },
});

/** 在指定位置插入 wiki 引用 chip（补全选中与拖放共用） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertWikiMentionAt(editor: any, range: { from: number; to: number } | number, props: { id: string; label: string }) {
  const content = [
    { type: "contentMention", attrs: { kind: "wiki", displayMode: null, id: props.id, aux: null, versionId: null, label: props.label } },
    { type: "text", text: " " },
  ];
  editor.chain().focus().insertContentAt(range, content).run();
}

// @ mention — works in both modes; adds markdown serialization for markdown mode.
// markdown 形态 [@名](uid:id)（@ 收进链接文本）：原 @[名](uid:id) 只有序列化没有
// 反序列化（被 StarterKit Link 抢走），重载即失真 → 保真警告 → 源码保存毁 chip
const AtMentionExt = Mention.extend({
  name: "atMention",
  parseHTML() {
    return [
      { tag: 'span[data-type="atMention"]' },
      {
        tag: "a",
        priority: 1001,
        getAttrs(el) {
          if (typeof el === "string") return false;
          const href = el.getAttribute("href") ?? "";
          if (!href.startsWith("uid:")) return false;
          const label = (el.textContent ?? "").replace(/^@/, "");
          return { id: href.slice(4) || null, label };
        },
      },
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { id: string | null; label: string } }) {
          const { id, label } = node.attrs;
          state.write(id ? `[@${label}](uid:${id})` : `@${label}`);
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
      atMention: ({ node }) => serializeAtMention(node.attrs.id as string | null, node.attrs.label as string),
    },
  });
}

// ── Upload placeholder helpers ───────────────────────────────────────────────

/** 占位翻失败态，几秒后自动撤——静默消失＝又回到「粘了没反应」 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function failPlaceholder(view: any, id: object) {
  view.dispatch(view.state.tr.setMeta(uploadPlaceholderKey, { fail: { id } }));
  setTimeout(() => {
    try {
      view.dispatch(view.state.tr.setMeta(uploadPlaceholderKey, { remove: { id } }));
    } catch { /* 编辑器已销毁 */ }
  }, 4000);
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
  /** markdown 模式去外框（Notion 式整页编辑场景） */
  frameless?: boolean;
  /** Extra custom-trigger plugins (escape hatch) */
  plugins?: DropPlugin[];
  /** 图片粘贴上传（wiki 文档场景）。提供即解锁 image 节点：粘贴的图片文件
   *  经此上传，返回存储形态 src（/__cm__asset:<id>）；未提供的面（活动纪要等）
   *  不注册 image 节点，粘贴图片行为与从前一致（被 schema 丢弃）。 */
  imageUpload?: (file: File) => Promise<{ src: string; alt: string } | null>;
  placeholder?: string;
  rows?: number;
  minHeight?: number;
  className?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  /** markdown 模式：编辑器就绪时回调"初始 value 解析后再序列化"的结果——
   *  调用方对比原文可检测富文本模式无法无损保留的语法（不支持的方言会被
   *  prosemirror-markdown 转义/规范化）。 */
  onInitialRoundTrip?: (serialized: string) => void;
  /** 协作：远端光标（顶层块索引+块内偏移=精确位）；变化即重绘装饰 */
  remoteCursors?: { name: string; color: string; blockIndex: number; offset: number }[];
  /** 协作：本端光标位置变化回调（块索引+块内字符偏移，去重后触发） */
  onCursorChange?: (cursor: { blockIndex: number; offset: number }) => void;
}

// ── SmartTextarea ─────────────────────────────────────────────────────────────

export default function SmartTextarea({
  value,
  onChange,
  memberMention,
  contentMention,
  markdown = false,
  frameless = false,
  plugins: extraPlugins = [],
  imageUpload,
  placeholder,
  rows = 3,
  minHeight,
  className = "",
  onKeyDown,
  autoFocus,
  readOnly = false,
  onInitialRoundTrip,
  remoteCursors,
  onCursorChange,
}: SmartTextareaProps) {
  const onInitialRoundTripRef = useRef(onInitialRoundTrip);
  onInitialRoundTripRef.current = onInitialRoundTrip;
  const remoteCursorsRef = useRef(remoteCursors ?? []);
  remoteCursorsRef.current = remoteCursors ?? [];
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  const lastCursorRef = useRef<{ blockIndex: number; offset: number } | null>(null);
  const [drop, setDrop] = useState<DropState>(null);
  const dropRef = useRef<DropState>(null);
  const lastEmittedRef = useRef(value);

  // Keep mutable refs so suggestion callbacks always see latest values
  const memberMentionRef = useRef(memberMention);
  memberMentionRef.current = memberMention;
  const contentMentionRef = useRef(contentMention);
  contentMentionRef.current = contentMention;
  const imageUploadRef = useRef(imageUpload);
  imageUploadRef.current = imageUpload;
  const hasImageUpload = !!imageUpload;
  // 飞书私有格式（docx/record）：分栏结构真相源。transformPastedHTML 只拿得到
  // HTML 字符串，record 在 DOM paste 事件先行截获经 ref 递进去
  const pasteRecordRef = useRef<string | null>(null);

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
  const hasWikiPlugin = allPlugins.some(p => p.trigger === "[[");

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
      // 默认 allowedPrefixes=[' '] 只在空格/行首后触发——CJK 文本后敲 @/#/[[
      // 全都不弹（用户实测）。任意前缀放开，三种触发器统一
      allowedPrefixes: null,
      startOfLine: false,
      pluginKey: new PluginKey(trigger === "#" ? "contentMention" : trigger === "@" ? "atMention" : "wikiMention"),
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

  // 协作远端光标：装饰器读 ref（cursors 变化由外层 ping 空事务触发重算）
  const remoteCursorExt = useMemo(() => {
    const cursorsRef = remoteCursorsRef;
    return Extension.create({
      name: "remoteCursors",
      addProseMirrorPlugins() {
        return [new Plugin({
          key: new PluginKey("remoteCursorsDeco"),
          props: {
            decorations(state) {
              const cursors = cursorsRef.current;
              if (!cursors.length) return DecorationSet.empty;
              const decos: Decoration[] = [];
              for (const c of cursors) {
                if (c.blockIndex == null || c.blockIndex < 0 || c.blockIndex >= state.doc.childCount) continue;
                let pos = 0;
                for (let i = 0; i < c.blockIndex; i++) pos += state.doc.child(i).nodeSize;
                // 精确位：块内容起点 + 偏移（钳到块内容尺寸——远端文档可能略有出入）
                const block = state.doc.child(c.blockIndex);
                const offset = Math.min(Math.max(0, c.offset ?? 0), block.content.size);
                decos.push(Decoration.widget(pos + 1 + offset, () => {
                  const el = document.createElement("span");
                  el.className = "wiki-remote-cursor";
                  el.style.setProperty("--rc-color", c.color);
                  el.setAttribute("data-name", c.name);
                  return el;
                }, { side: -1 }));
              }
              return DecorationSet.create(state.doc, decos);
            },
          },
        })];
      },
    });
  }, []);

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
      // v3 Mention 退格默认把 chip 还原成 mentionSuggestionChar（未设=@）——
      // 用户实测删 wiki chip 留下 '@'；改为整颗删净
      deleteTriggerWithBackspace: true,
      renderText: ({ node }) => {
        const { kind, displayMode, id, aux, versionId } = node.attrs as ContentMentionAttrs;
        return serializeMention({ kind, displayMode, id, aux, versionId });
      },
      renderHTML: ({ node }) => {
        const { kind, displayMode, id, aux, versionId, label } = node.attrs;
        // wiki 引用（含重载回流的 [[链接]]）用 sky 色 [[标题]] 形态，与剧本域 # 区分
        const isWiki = kind === "wiki";
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
            class: isWiki
              ? "inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-sky-50 text-sky-700 border border-sky-200 cursor-pointer hover:bg-sky-100"
              : "inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 text-amber-700 border border-amber-200 cursor-pointer hover:bg-amber-100",
          },
          isWiki ? `[[${label ?? "文档"}]]` : `#${label ?? kind}`,
        ];
      },
      suggestion: makeSuggestion("#", hasHashPlugin),
    });

    const wikiTriggerCfg = WikiLinkTrigger.configure({
      suggestion: {
        ...makeSuggestion("[[", hasWikiPlugin),
        command: ({ editor, range, props }: { editor: unknown; range: { from: number; to: number }; props: { id: string; label: string } }) => {
          insertWikiMentionAt(editor, range, props);
        },
      },
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

    // image 节点仅在提供 imageUpload 的面（wiki）注册：src 存 /__cm__asset:<id>，
    // 展示经 thumb 端点（session 鉴权，img src 直接可流）
    const imageExt = WikiImage.configure({
      resolveSrc: (src) => {
        const m = /^\/__cm__asset:([^/?#\s]+)$/.exec(src);
        const pid = contentMentionRef.current?.productionId;
        if (m && pid) return `${BASE_PATH}/api/production/${pid}/assets/${m[1]}/thumb`;
        return src;
      },
    });

    return markdown
      // breaks: 单回车=换行（CJK 写作习惯，与 WikiMarkdown remark-breaks 对齐）；
      // TableKit: StarterKit 不含表格节点，缺了它 markdown 表格进编辑器会被吞
      ? [base, Markdown.configure({ transformCopiedText: true, breaks: true }),
         TableKit.configure({ table: { resizable: false } }),
         TaskList, TaskItem.configure({ nested: true }),
         Callout, Column, ColumnGroup,
         ...(hasImageUpload ? [imageExt, UploadPlaceholder] : []),
         ...commonExts, wikiTriggerCfg, remoteCursorExt]
      : [base, ...commonExts];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, remoteCursorExt, hasImageUpload]);

  const editorMinHeight = minHeight != null
    ? `${minHeight}px`
    : `${rows * 1.375}em`;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions,
    content: markdown ? normalizeLegacyMentions(value) : parseToDoc(value),
    autofocus: autoFocus,
    editorProps: {
      attributes: {
        class: markdown
          ? "prose prose-zinc max-w-none focus:outline-none px-3 py-2 smart-textarea-content"
          : "outline-none smart-textarea-content",
        style: readOnly ? "" : `min-height:${editorMinHeight}`,
      },
      // 飞书粘贴归一化（junk 清理/代码块/checklist/@提及映射，lib/feishu-paste）。
      // 只认飞书来源标记，其他粘贴源原样放行；失败也放行——宁可少归一化不拦粘贴
      handleDOMEvents: {
        // 在 PM 处理 paste 之前截获飞书私有格式（返回 false 不拦默认流程）
        paste: (_view, event) => {
          try {
            pasteRecordRef.current = event.clipboardData?.getData("docx/record") || null;
          } catch {
            pasteRecordRef.current = null;
          }
          return false;
        },
      },
      transformPastedHTML: (html) => {
        if (!isFeishuHtml(html)) return html;
        try {
          const record = pasteRecordRef.current;
          pasteRecordRef.current = null;
          return transformFeishuHtml(html, { members: memberMentionRef.current?.members, record });
        } catch {
          return html;
        }
      },
      // 图片文件粘贴（wiki 场景）：拦 file items 上传转存后插节点。
      // 飞书「复制图片」实测剪贴板携带真文件走此路径；整篇文档粘贴无 file，
      // 不会被此分支劫持（照走 transformPastedHTML）。
      // 粘贴瞬间挂 decoration 占位（lib/tiptap-upload-placeholder）——没有即时
      // 反馈用户会以为粘贴无效而反复贴；decoration 不进正史不广播，天然安全
      handlePaste: (view, event) => {
        const upload = imageUploadRef.current;
        if (!upload) return false;
        const files = Array.from(event.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/"));
        if (files.length === 0) return false;
        event.preventDefault();
        void (async () => {
          for (const f of files) {
            const id = {}; // 对象身份即占位句柄
            const name = f.name || "粘贴图片";
            {
              const tr = view.state.tr;
              if (!tr.selection.empty) tr.deleteSelection();
              tr.setMeta(uploadPlaceholderKey, { add: { id, pos: tr.selection.from, name } });
              view.dispatch(tr);
            }
            try {
              const res = await upload(f);
              // 占位已被用户删掉 = 取消，不再插入
              const pos = findUploadPlaceholder(view.state, id);
              if (pos == null) continue;
              const imgType = view.state.schema.nodes.image;
              if (res && imgType) {
                view.dispatch(
                  view.state.tr
                    .insert(pos, imgType.create({ src: res.src, alt: res.alt }))
                    .setMeta(uploadPlaceholderKey, { remove: { id } })
                    .scrollIntoView(),
                );
              } else {
                failPlaceholder(view, id);
              }
            } catch {
              failPlaceholder(view, id); // 单张失败不影响其余
            }
          }
        })();
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (!dropRef.current) {
          onKeyDown?.(event);
          return event.defaultPrevented;
        }
        return false;
      },
      // 富文本 chip 点击跳转（wiki 直跳文档页；剧本域 chip 经 mention-resolve 取 url）。
      // chip 是原子节点，点击导航是自然语义（飞书/Notion 同款）
      handleClickOn: (_view, _pos, node) => {
        if (node.type.name !== "contentMention") return false;
        const pid = contentMentionRef.current?.productionId;
        if (!pid) return false;
        const { kind, id, aux, versionId, displayMode } = node.attrs as ContentMentionAttrs;
        if (kind === "wiki") {
          window.location.assign(`${BASE_PATH}/production/${pid}/wiki/${id}`);
          return true;
        }
        void (async () => {
          try {
            const res = await fetch(`${BASE_PATH}/api/production/${pid}/mention-resolve`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mentions: [{ kind, displayMode, id, aux, versionId }] }),
            });
            if (!res.ok) return;
            const data = await res.json() as { urls: (string | null)[] };
            if (data.urls?.[0]) window.location.assign(`${BASE_PATH}${data.urls[0]}`);
          } catch { /* 解析失败不跳 */ }
        })();
        return true;
      },
      // 从文档树拖文档进编辑器 → 自动成为双向链接 chip（UI 修缮轮）
      handleDrop: (view, event) => {
        const raw = event.dataTransfer?.getData("application/x-clickin-wiki");
        if (!raw) return false;
        try {
          const { id, label } = JSON.parse(raw) as { id: string; label: string };
          if (!id) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            ?? view.state.selection.to;
          const node = view.state.schema.nodes.contentMention.create({
            kind: "wiki", displayMode: null, id, aux: null, versionId: null, label: label ?? "文档",
          });
          view.dispatch(view.state.tr.insert(pos, [node, view.state.schema.text(" ")]));
          return true;
        } catch {
          return false;
        }
      },
    },
    onSelectionUpdate: ({ editor }) => {
      const cb = onCursorChangeRef.current;
      if (!cb) return;
      try {
        const $head = editor.state.selection.$head;
        if ($head.depth < 1) return;
        const blockIndex = $head.index(0);
        // 块内偏移：绝对 pos - 顶层块内容起点（跨嵌套结构展平计数）
        const offset = Math.max(0, $head.pos - $head.start(1));
        const last = lastCursorRef.current;
        if (!last || last.blockIndex !== blockIndex || last.offset !== offset) {
          lastCursorRef.current = { blockIndex, offset };
          cb({ blockIndex, offset });
        }
      } catch { /* selection 在非常规位置时忽略 */ }
    },
    onCreate: ({ editor }) => {
      if (markdown && onInitialRoundTripRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onInitialRoundTripRef.current((editor.storage as any).markdown.getMarkdown());
      }
    },
    onUpdate: ({ editor, transaction }) => {
      // 标题活刷新的静默 transaction（见下方 wiki mention 标题活刷新 effect）——
      // 纯展示刷新，不算真实编辑，不触发 onChange/自动保存
      if (transaction.getMeta("wikiLabelRefresh")) return;
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
        const members = memberMentionRef.current.members;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function traverse(node: any) {
          if (node.type !== "atMention" && node.type !== "mention") {
            node.content?.forEach(traverse);
            return;
          }
          const label: string | undefined = node.attrs?.label;
          let userId: string | undefined = node.attrs?.id ?? undefined;
          if (!userId && label) {
            const matches = members.filter(m => m.name === label);
            if (matches.length === 1) userId = matches[0].userId;
          }
          if (userId && !seen.has(userId)) {
            seen.add(userId);
            mentioned.push({ userId, name: label ?? userId });
          }
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
    const newContent = markdown ? normalizeLegacyMentions(value) : parseToDoc(value);
    const { from, to } = editor.state.selection;
    editor.commands.setContent(newContent, { emitUpdate: false });
    // 协作合并回灌时保留本端选区（钳到新文档尺寸内）
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
  }, [value, editor, markdown]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta("remoteCursorsPing", true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(remoteCursors ?? []), editor]);

  // wiki mention 标题活刷新：contentMention chip 的 label attr 只是解析/插入时的
  // 快照（同 WikiMarkdown/SmartText 一样不可信——目标文档改名后会长期挂着旧标题）。
  // 只读渲染那两处天生走 mention-resolve 逐次覆盖；这里手动补一次，用静默
  // transaction（wikiLabelRefresh meta，onUpdate 见上方）落地，不触发自动保存。
  const wikiLabelSigRef = useRef("");
  useEffect(() => {
    if (!markdown || !editor || editor.isDestroyed) return;
    const pid = contentMentionRef.current?.productionId;
    if (!pid) return;
    const ids = new Set<string>();
    editor.state.doc.descendants((node) => {
      if (node.type.name === "contentMention" && node.attrs.kind === "wiki" && node.attrs.id) {
        ids.add(node.attrs.id as string);
      }
    });
    if (ids.size === 0) return;
    const idList = [...ids].sort();
    const sig = idList.join(",");
    if (wikiLabelSigRef.current === sig) return;
    wikiLabelSigRef.current = sig;
    (async () => {
      try {
        const mentions = idList.map(id => ({ kind: "wiki", displayMode: null, id, aux: null, versionId: null }));
        const res = await fetch(`${BASE_PATH}/api/production/${pid}/mention-resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mentions }),
        });
        if (!res.ok || editor.isDestroyed) return;
        const data = await res.json() as { labels: (string | null)[] };
        const labelById = new Map<string, string>();
        idList.forEach((id, i) => { if (data.labels[i]) labelById.set(id, data.labels[i]!); });
        if (labelById.size === 0) return;
        const tr = editor.state.tr;
        let changed = false;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name !== "contentMention" || node.attrs.kind !== "wiki") return;
          const fresh = labelById.get(node.attrs.id as string);
          if (fresh && fresh !== node.attrs.label) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, label: fresh });
            changed = true;
          }
        });
        if (changed) {
          tr.setMeta("addToHistory", false);
          tr.setMeta("wikiLabelRefresh", true);
          editor.view.dispatch(tr);
        }
      } catch { /* 静默失败，chip 保留旧快照 */ }
    })();
  }, [markdown, editor, value]);

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
    const frame = readOnly
      ? "overflow-hidden"
      : frameless
        ? `overflow-hidden ${className}`
        : `rounded-lg border border-zinc-200 focus-within:border-zinc-400 overflow-hidden bg-white ${className}`;
    return (
      <div className={frame}>
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
