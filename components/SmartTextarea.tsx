"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension, type Editor } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import Placeholder from "@tiptap/extension-placeholder";
import { Mention } from "@tiptap/extension-mention";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Suggestion from "@tiptap/suggestion";
import { PluginKey, Plugin, NodeSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { match as pinyinMatch } from "pinyin-pro";
import { BASE_PATH } from "@/lib/base-path";
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { MentionSearchResult } from "@/lib/mention-types";
import {
  encodeMentionHref, decodeMentionHref, CM_HREF_PREFIX,
  encodeUserHref, decodeUserHref, decodeAssetSrc,
  type ContentMentionAttrs,
} from "@/lib/mention-types";
import { normalizeLegacyMentions } from "@/lib/mention-format";
import { normalizeWikiDialect } from "@/lib/wiki-dialect-migrate";
import { isFeishuHtml, transformFeishuHtml } from "@/lib/feishu-paste";
import { Callout } from "@/lib/tiptap-callout";
import { WikiImage } from "@/lib/tiptap-wiki-image";
import { UploadPlaceholder, uploadPlaceholderKey, findUploadPlaceholder } from "@/lib/tiptap-upload-placeholder";
import { Column, ColumnGroup } from "@/lib/tiptap-columns";
import { ColumnDrop } from "@/lib/tiptap-column-drop";
import { ColumnEditing } from "@/lib/tiptap-column-editing";
import { ColumnResize } from "@/lib/tiptap-column-resize";
import { SLASH_COMMANDS, searchSlashCommands } from "@/lib/editor-slash-commands";
import { DROP_INDICATOR_OPTIONS } from "@/lib/editor-drop-indicator";
import TextBubbleMenu from "@/components/editor/TextBubbleMenu";
import BlockHandle from "@/components/editor/BlockHandle";
import BlockTypeIcon from "@/components/editor/BlockTypeIcon";
export { normalizeLegacyMentions };

// ── Public types ──────────────────────────────────────────────────────────────

export type MentionMember = { userId: string; name: string; avatarUrl?: string | null };

export type DropItem = { id: string; label: string; secondary?: string; data?: unknown };

export type DropPlugin = {
  trigger: string;
  allowSpaces?: boolean;
  emptyLabel?: string;
  /** 无候选时整个弹层不显示（而非显示 emptyLabel）。`/` 专用——正文里
   *  「and/or」这类普通斜杠不该弹出一个空菜单来碍事 */
  hideWhenEmpty?: boolean;
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
      return `[#](${encodeMentionHref({ kind: r.kind, displayMode: r.displayMode ?? null, id: r.id, aux: r.aux ?? null, versionId: null })})`;
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
// markdown 序列化为 [#](/__cm__/wiki/<id>)（存 id 不存标题——显示位是恒定哨兵，
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
    format: (item) => `[#](${encodeMentionHref({ kind: "wiki", displayMode: null, id: item.id, aux: null, versionId: null })})`,
    toNode: (item) => ({ id: item.id, label: item.label }),
  };
}

// ── Factory: /slash 布局指令 ──────────────────────────────────────────────────
// 语法大纲 §6.2 的第四个指令源。与前三个的差异**只有两处**：候选从哪来
// （静态表，不是网络查询）、选中后干什么（跑编辑器命令，不是插引用节点）。
// 框架本身零改动——这正是「四者是同一个框架的四个注册项」的验证。

export function slashCommandPlugin(): DropPlugin {
  return {
    trigger: "/",
    hideWhenEmpty: true,
    search: (query) => searchSlashCommands(query).map(c => ({
      id: c.id, label: c.label, secondary: c.hint,
    })),
    renderItem: (item, active) => {
      const cmd = SLASH_COMMANDS.find(c => c.id === item.id);
      return (
        <span className="flex items-center gap-2.5">
          <BlockTypeIcon icon={cmd?.icon} active={active} />
          <span className="text-sm text-zinc-700">{item.label}</span>
          <span className="ml-auto text-[11px] font-mono text-zinc-400 pl-3">{item.secondary}</span>
        </span>
      );
    },
    // 指令不落文本形态：选中即执行命令，查询串被 deleteRange 吃掉（§6.1——
    // 「查询」与「结果」的关系，不是「简写」与「展开」）
    format: () => "",
    toNode: (item) => ({ id: item.id }),
  };
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
        serialize(state: { write: (s: string) => void }, node: { attrs: ContentMentionAttrs }) {
          const { kind, displayMode, id, aux, versionId } = node.attrs;
          const href = encodeMentionHref({ kind, displayMode, id, aux, versionId });
          // 显示位恒为固定哨兵 "#"，**所有 kind 一视同仁**（语法大纲 G4：显示位是
          // 缓存不是真相）。原先只有 wiki 落 "#"、其余 kind 落 `#${label}`——那段
          // label 是编辑期快照，目标改名后就冻在正文里，看着像"链接坏了"。
          // 为什么不真的留空 `[](…)`：空链接文字在不认方言的渲染器里**完全不可见**，
          // 违反 G5「降级可读」；`#` 携带零信息、永不过期，是"留空"的可降级写法。
          state.write(`[#](${href})`);
        },
      },
    };
  },
});

// [[wikilink 触发器（UI 修缮轮重构）：不再用独立 node——插入走已验证的
// contentMention(kind='wiki') 管线（序列化/重载/chip 渲染全部现成）。
// 独立 Suggestion 插件而非 Mention 内建：可设 allowedPrefixes=null——
// 默认只在空格/行首后触发，CJK 文本后直接敲 [[ 原本根本不弹补全（首版 bug 根因）。
//
// `/` 指令源同理（布局指令，语法大纲 §6.2），故抽成工厂——两个触发器除了名字
// 没有任何差别，真正的差异全在传进来的 suggestion 配置里。
function makeTriggerExtension(name: string) {
  return Extension.create<{ suggestion: Record<string, unknown> }>({
    name,
    addOptions() {
      return { suggestion: {} };
    },
    addProseMirrorPlugins() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return [Suggestion({ editor: this.editor, ...(this.options.suggestion as any) })];
    },
  });
}

const WikiLinkTrigger = makeTriggerExtension("wikiLinkTrigger");
const SlashTrigger = makeTriggerExtension("slashTrigger");

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
// markdown 形态 [@名](/__cm__/user/<id>)：@ 收进链接文本（原 @[名](uid:id) 只有
// 序列化没有反序列化，被 StarterKit Link 抢走，重载即失真 → 保真警告 → 源码保存毁 chip）。
//
// href 从 `uid:` 换成引用 URI 路径形态是**线上 bug 修复**，不只是形态统一：
// react-markdown 的 defaultUrlTransform 会把 `uid:` 当未知协议剥成空串，
// WikiMarkdown 里 `h.startsWith("uid:")` 分支因此永不命中，wiki 正文的 @提及
// 一直渲染成 <a href="">（点击重载页面）而不是蓝色 chip。详见 mention-types.ts。
//
// 唯一保留 label 的引用类型：姓名没有解析端点（mention-resolve 不支持 user
// kind），留空就彻底没得显示。等 user 解析接上后，这里收敛成 `[@](…)`，与
// contentMention 的固定哨兵一致。姓名改动远低频于文档改名，冻结代价可接受。
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
          const id = decodeUserHref(href); // 新形态 + 旧 uid: 双读（历史版本）
          if (!id) return false;
          const label = (el.textContent ?? "").replace(/^@/, "");
          return { id, label };
        },
      },
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { id: string | null; label: string } }) {
          const { id, label } = node.attrs;
          state.write(id ? `[@${label}](${encodeUserHref(id)})` : `@${label}`);
        },
      },
    };
  },
});



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
  /** 块工具：左侧手柄（＋/⠿）、拖拽排序、块选中与块操作。
   *  只给 wiki 整页这种**有左侧留白的大编辑面**——活动纪要、公告那类
   *  180~360px 的小框既没有放手柄的地方，也用不到块级移动/分栏。
   *  浮动条不受此门控（它贴选区，不占版面），markdown 面一律有。 */
  blockTools?: boolean;
  /** Extra custom-trigger plugins (escape hatch) */
  plugins?: DropPlugin[];
  /** 图片粘贴上传（wiki 文档场景）。提供即解锁 image 节点：粘贴的图片文件
   *  经此上传，返回存储形态 src（/__cm__/asset/<id>）；未提供的面（活动纪要等）
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
  blockTools = false,
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
  // 布局指令源随富文本能力走：markdown 面才有分栏/表格/callout 可插
  if (markdown && !readOnly) {
    derivedPlugins.push(slashCommandPlugin());
  }
  const allPlugins = [...derivedPlugins, ...extraPlugins];
  allPluginsRef.current = allPlugins;

  const hasHashPlugin = allPlugins.some(p => p.trigger === "#");
  const hasAtPlugin = allPlugins.some(p => p.trigger === "@");
  const hasWikiPlugin = allPlugins.some(p => p.trigger === "[[");
  const hasSlashPlugin = allPlugins.some(p => p.trigger === "/");

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
      // 无候选时把导航/确认键交还编辑器。`/` 尤其需要：正文里写「and/or」之后
      // 敲回车，若这里照旧 return true，换行就被一个看不见的空菜单吞了。
      // （`#zzz` 无匹配时按回车没反应也是同一个洞，一并堵上；Escape 仍由这里
      //  处理——它要负责关掉 # / @ 的「无匹配」提示弹层。）
      if (d.items.length === 0 && event.key !== "Escape") return false;
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
      pluginKey: new PluginKey(
        trigger === "#" ? "contentMention"
          : trigger === "@" ? "atMention"
            : trigger === "/" ? "slashCommand"
              : "wikiMention"),
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

  // 栏操作件（造栏落点 + 栏宽拖拽）的开关。dropcursor 的取舍要跟它一致：
  // 关了内建横线却又没装 ColumnDrop，就会一条落点指示都没有
  const hasColumnTools = blockTools && !readOnly;

  const extensions = useMemo(() => {
    // 全站同一套文档 schema。原先 plain 面阉掉了 bold/heading/list 等节点——
    // 那在「正文按自定义 token 存」的时代无害，但存储统一成 markdown 之后就是
    // **内容丢失**：`*foo*` 会被 tiptap-markdown 解析成 emphasis、再被没有该 mark
    // 的 schema 丢弃，重新序列化时星号就消失了，而 plain 面没有保真锁兜底。
    // 生产库实测：plain 列里带 markdown 语法的一共 3 行（两条有序列表），
    // 所以「统一 schema」的观感代价可忽略，而丢内容的风险是实打实的。
    // 拖拽落点指示线 —— 理由与选型见 lib/editor-drop-indicator.ts。
    // 注意 StarterKit 的选项键是小写 dropcursor，扩展自身的名字却是 dropCursor。
    //
    // blockTools 面**整个关掉内建 dropcursor**：那里由 ColumnDrop 统一画横线与
    // 竖线。两套指示系统并存就得互相抑制，而 dropcursor 的禁用分支不清除已画
    // 上的线，抑制不干净（详见 tiptap-column-drop.ts）。只留一个元素，互斥由
    // 「同一时刻只可能有一种形态」天然保证。
    const base = StarterKit.configure({
      dropcursor: hasColumnTools ? false : { ...DROP_INDICATOR_OPTIONS },
    });

    const contentMentionCfg = ContentMentionExt.configure({
      // v3 Mention 退格默认把 chip 还原成 mentionSuggestionChar（未设=@）——
      // 用户实测删 wiki chip 留下 '@'；改为整颗删净
      deleteTriggerWithBackspace: true,
      renderText: ({ node }) => {
        const { kind, displayMode, id, aux, versionId } = node.attrs as ContentMentionAttrs;
        return `[#](${encodeMentionHref({ kind, displayMode, id, aux, versionId })})`;
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

    // 指令面：选中即执行命令，查询串（`/fenlan`）由命令自己的 deleteRange 吃掉，
    // 正文不留痕迹。这与前三个触发器插入节点是同一个位置的不同动作
    const slashTriggerCfg = SlashTrigger.configure({
      suggestion: {
        ...makeSuggestion("/", hasSlashPlugin),
        command: ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: { id: string } }) => {
          SLASH_COMMANDS.find(c => c.id === props.id)?.run(editor, range);
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

    // image 节点仅在提供 imageUpload 的面（wiki）注册：src 存 /__cm__/asset/<id>，
    // 展示经 thumb 端点（session 鉴权，img src 直接可流）
    const imageExt = WikiImage.configure({
      resolveSrc: (src) => {
        const assetId = decodeAssetSrc(src); // 新旧形态双读
        const pid = contentMentionRef.current?.productionId;
        if (assetId && pid) return `${BASE_PATH}/api/production/${pid}/assets/${assetId}/thumb`;
        return src;
      },
    });

    // breaks: 单回车=换行（CJK 写作习惯，与 WikiMarkdown remark-breaks 对齐）
    const markdownExt = Markdown.configure({ transformCopiedText: true, breaks: true });

    // 「一切文本皆文档」：**两个分支都挂 Markdown 扩展**，存储形态统一为 markdown。
    // `markdown` prop 从此只决定「开哪些富文本能力 + 要不要工具栏」，不再决定
    // 正文怎么存——原先 plain 分支走 serializeDoc 自造 [#kind:id] token，那是
    // 文档概念成型之前各造各的产物（生产库实测：plain 面一条 token 都没有）。
    // 扩展集也只有一套：`markdown` prop 只决定要不要工具栏（见下方渲染），
    // 不再决定能力。image 仍按 imageUpload 是否提供门控——它需要一个上传器。
    // TableKit: StarterKit 不含表格节点，缺了它 markdown 表格进编辑器会被吞。
    return [base, markdownExt,
      TableKit.configure({ table: { resizable: false } }),
      TaskList, TaskItem.configure({ nested: true }),
      // ColumnEditing 不随 blockTools 门控：空栏退格、禁止嵌套是分栏方言自身
      // 的不变量，哪个面都得维护（粘贴、AI 写入都可能造出嵌套组）
      Callout, Column, ColumnGroup, ColumnEditing,
      // 拖拽造栏、栏宽拖拽只在有手柄的面才有意义（也才有那条栏间沟槽放操作件）
      ...(hasColumnTools ? [ColumnDrop, ColumnResize] : []),
      ...(hasImageUpload ? [imageExt, UploadPlaceholder] : []),
      ...commonExts, wikiTriggerCfg, slashTriggerCfg, remoteCursorExt];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, remoteCursorExt, hasImageUpload, blockTools, hasColumnTools]);

  const editorMinHeight = minHeight != null
    ? `${minHeight}px`
    : `${rows * 1.375}em`;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions,
    content: normalizeWikiDialect(value),
    autofocus: autoFocus,
    editorProps: {
      attributes: {
        // blockTools 面要给手柄让出左侧沟槽，否则 ＋/⠿ 会压在正文第一个字上
        class: markdown
          ? `prose prose-zinc max-w-none focus:outline-none px-3 py-2 smart-textarea-content${blockTools ? " smart-textarea-blocktools" : ""}`
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
        // 块拖拽自环保护（调研 §2.6 ②：必须禁止「拖进自己的子树」）。
        // 拖住一个 columnGroup 往它自己的某一栏里放，PM 会先删源节点再按旧坐标
        // 插入，落点已经不存在 → 文档结构损坏。源区间由拖拽起始的 NodeSelection
        // 给出，落点在区间内即整个吞掉这次 drop（拖拽取消，文档不动）
        if (view.dragging) {
          const sel = view.state.selection;
          if (sel instanceof NodeSelection) {
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            if (at != null && at > sel.from && at < sel.to) {
              event.preventDefault();
              return true;
            }
          }
        }
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
      if (onInitialRoundTripRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onInitialRoundTripRef.current((editor.storage as any).markdown.getMarkdown());
      }
    },
    onUpdate: ({ editor, transaction }) => {
      // 标题活刷新的静默 transaction（见下方 wiki mention 标题活刷新 effect）——
      // 纯展示刷新，不算真实编辑，不触发 onChange/自动保存
      if (transaction.getMeta("wikiLabelRefresh")) return;
      if (readOnly) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text: string = (editor.storage as any).markdown.getMarkdown();
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

  // 拖拽进行中到达的协作回灌先攒着，dragend 再补上（见下方 effect）
  const pendingValueRef = useRef<string | null>(null);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmittedRef.current) return;
    // 块拖拽中途 setContent 会把整个 doc 换掉，PM 手里的 dragging slice 与落点
    // 坐标全部失效——轻则拖拽静默失败，重则内容落到错误位置。攒到拖完再灌。
    // （文本拖选也走这条，同样是对的：拖到一半文档被换掉本来就不该发生）
    if (editor.view.dragging) {
      pendingValueRef.current = value;
      return;
    }
    lastEmittedRef.current = value;
    const newContent = normalizeWikiDialect(value);
    const { from, to } = editor.state.selection;
    editor.commands.setContent(newContent, { emitUpdate: false });
    // 协作合并回灌时保留本端选区（钳到新文档尺寸内）
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
  }, [value, editor, markdown]);

  // 拖拽结束补灌被推迟的协作内容。挂 document 而不是编辑器 DOM——拖到编辑器
  // 外面松手时 dragend 只在 document 上冒泡，挂里面会永远等不到、pending 卡死
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const flush = () => {
      const pending = pendingValueRef.current;
      pendingValueRef.current = null;
      if (pending == null || editor.isDestroyed) return;
      if (pending === lastEmittedRef.current) return;
      lastEmittedRef.current = pending;
      editor.commands.setContent(normalizeWikiDialect(pending), { emitUpdate: false });
    };
    document.addEventListener("dragend", flush);
    return () => document.removeEventListener("dragend", flush);
  }, [editor]);

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
  // `/` 无命中时整个弹层不出现——正文里的 and/or、日期 2026/08 不该弹空菜单
  const dropPlugin = drop ? allPlugins.find(p => p.trigger === drop.trigger) : undefined;
  const dropHidden = !!drop && drop.items.length === 0 && !!dropPlugin?.hideWhenEmpty;

  const editorEl = (
    <>
      {/* 手柄 wrapper 由插件挂到 view.dom 的父元素上并绝对定位，这层必须是
          定位元素——见 globals.css .smart-textarea-shell */}
      <EditorContent editor={editor} className="smart-textarea-shell" />
      {/* 浮动条与固定工具栏的作用域严格一致（markdown 面），commit「收工具栏」
          才是 1:1 替换而不是能力平移 */}
      {markdown && !readOnly && <TextBubbleMenu editor={editor} />}
      {markdown && blockTools && !readOnly && <BlockHandle editor={editor} />}
      {drop && rect && !dropHidden && typeof document !== "undefined" &&
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
    // 固定工具栏已退役：格式走选中浮出的文本浮动条，插入走 `/` 指令源，
    // 块级操作走左侧手柄。Notion 式整页编辑不该常驻一条工具栏。
    return <div className={frame}>{editorEl}</div>;
  }

  return (
    <div className={`${className} focus-within:border-zinc-400`} onClick={() => editor?.commands.focus()}>
      {editorEl}
    </div>
  );
}
