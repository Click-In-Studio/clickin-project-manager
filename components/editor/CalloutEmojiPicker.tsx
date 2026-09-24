"use client";

// 高亮块图标选择器（#525 图标一半）——参照飞书：点高亮块左上角的表情弹出，
// 搜索框 + 最近使用 + 分组网格，底部「无图标」。
//
// 两个入口，同一个面板：
//   ① 点图标——图标是 .wiki-callout 的 ::before，伪元素不是事件目标，所以监听
//      editor.view.dom 的 mousedown，命中「目标就是 .wiki-callout 自身 + 坐标落在
//      左上角」才算点中图标（lib/editor/callout-emoji.calloutIconHit）。
//   ② 块菜单「换图标」——BlockMenu 在 view.dom 上派发 CALLOUT_EMOJI_PICKER_EVENT。
//
// 与 TextBubbleMenu 同款：挂 body + fixed，按钮 onMouseDown + preventDefault 保
// 编辑器选区；定位走 #671 的 suggestionMenuLayout，靠底向上开、靠右夹回视口。

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import {
  CALLOUT_EMOJI_GROUPS, CALLOUT_EMOJI_PICKER_EVENT, calloutIconHit,
  findCalloutEmoji, pushRecentEmoji, readRecentEmoji, searchCalloutEmoji,
} from "@/lib/editor/callout-emoji";
import { setCalloutEmoji } from "@/lib/editor/editor-block-ops";
import { suggestionMenuLayout } from "@/lib/editor/editor-floating-menu";

type Target = { pos: number; anchor: { left: number; top: number; bottom: number } };

const PANEL_WIDTH = 336;
const PANEL_HEIGHT = 380;

function anchorOf(el: Element): Target["anchor"] {
  const r = el.getBoundingClientRect();
  // 贴着图标那一格（左上 40×40）展开，不是贴整个块
  return { left: r.left + 8, top: r.top + 4, bottom: r.top + 40 };
}

export default function CalloutEmojiPicker({ editor }: { editor: Editor | null }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);

  // 入口 ①②：都挂在 view.dom 上，编辑器换实例时随之重挂
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    const onDown = (ev: MouseEvent) => {
      if (!editor.isEditable || ev.button !== 0) return;
      const el = ev.target as HTMLElement | null;
      if (!el || !el.classList?.contains("wiki-callout")) return; // 点在正文里 target 是 p，不是块本身
      if (!calloutIconHit(el.getBoundingClientRect(), ev.clientX, ev.clientY)) return;
      const pos = editor.view.posAtDOM(el, 0) - 1; // posAtDOM(el,0) 是内容起点 = 节点位置 + 1
      if (editor.state.doc.nodeAt(pos)?.type.name !== "callout") return;
      ev.preventDefault(); // 别让 PM 把光标挪进去、也别让面板一开就失焦
      setQuery("");
      setRecent(readRecentEmoji());
      setTarget({ pos, anchor: anchorOf(el) });
    };
    const onOpen = (ev: Event) => {
      const pos = (ev as CustomEvent<{ pos: number }>).detail?.pos;
      if (typeof pos !== "number" || editor.state.doc.nodeAt(pos)?.type.name !== "callout") return;
      const el = editor.view.nodeDOM(pos) as Element | null;
      if (!el) return;
      setQuery("");
      setRecent(readRecentEmoji());
      setTarget({ pos, anchor: anchorOf(el) });
    };
    dom.addEventListener("mousedown", onDown);
    dom.addEventListener(CALLOUT_EMOJI_PICKER_EVENT, onOpen);
    return () => {
      dom.removeEventListener("mousedown", onDown);
      dom.removeEventListener(CALLOUT_EMOJI_PICKER_EVENT, onOpen);
    };
  }, [editor]);

  // 点外面 / Esc / 正文变了（位置可能失效）就关
  useEffect(() => {
    if (!target || !editor) return;
    const close = () => setTarget(null);
    const onDown = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement | null)?.closest?.("[data-callout-emoji-picker]")) close();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    editor.on("update", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      editor.off("update", close);
    };
  }, [target, editor]);

  const results = useMemo(() => searchCalloutEmoji(query), [query]);
  const current = target && editor ? (editor.state.doc.nodeAt(target.pos)?.attrs.emoji as string | undefined) ?? "" : "";

  if (!editor || !target || typeof document === "undefined") return null;

  const layout = suggestionMenuLayout(target.anchor, { width: window.innerWidth, height: window.innerHeight }, {
    width: PANEL_WIDTH, maxHeight: PANEL_HEIGHT,
  });

  const pick = (emoji: string) => {
    if (setCalloutEmoji(editor, emoji, target.pos) && emoji) setRecent(pushRecentEmoji(emoji));
    setTarget(null);
  };

  const cell = (emoji: string, key: string) => {
    const item = findCalloutEmoji(emoji);
    return (
      <button
        key={key}
        type="button"
        title={item?.name ?? emoji}
        aria-label={item ? `${item.name} ${emoji}` : emoji}
        aria-pressed={emoji === current}
        onMouseDown={ev => ev.preventDefault()}
        onClick={() => pick(emoji)}
        className={`h-9 w-9 rounded-md text-[20px] leading-none transition-colors ${
          emoji === current ? "bg-sky-100 ring-1 ring-sky-400" : "hover:bg-zinc-100"
        }`}
      >
        {emoji}
      </button>
    );
  };

  const grid = (nodes: React.ReactNode) => <div className="grid grid-cols-8 gap-0.5 px-2">{nodes}</div>;
  const label = (text: string) => <p className="px-3 pt-2 pb-1 text-[11px] font-medium text-zinc-400">{text}</p>;

  return createPortal(
    <div
      data-callout-emoji-picker=""
      data-placement={layout.placement}
      role="dialog"
      aria-label="选择高亮块图标"
      style={{
        position: "fixed",
        left: layout.left,
        top: layout.top,
        width: layout.maxWidth,
        maxHeight: layout.maxHeight,
        transform: layout.placement === "top" ? "translateY(-100%)" : undefined,
        zIndex: 9999,
      }}
      className="flex flex-col rounded-xl border border-zinc-100 bg-white shadow-lg"
    >
      <div className="px-2 pt-2">
        <input
          autoFocus
          value={query}
          onChange={ev => setQuery(ev.target.value)}
          placeholder="搜索表情（中文 / 拼音 / 英文）"
          aria-label="搜索表情"
          className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-400"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {results ? (
          results.length === 0
            ? <p className="px-3 py-6 text-center text-sm text-zinc-400">没有找到「{query.trim()}」</p>
            : <>{label("搜索结果")}{grid(results.map(i => cell(i.emoji, `s-${i.emoji}`)))}</>
        ) : (
          <>
            {recent.length > 0 && <>{label("最近使用")}{grid(recent.map(x => cell(x, `r-${x}`)))}</>}
            {CALLOUT_EMOJI_GROUPS.map(g => (
              <div key={g.label}>
                {label(g.label)}
                {grid(g.items.map(i => cell(i.emoji, `${g.label}-${i.emoji}`)))}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="border-t border-zinc-100 px-2 py-1.5">
        <button
          type="button"
          onMouseDown={ev => ev.preventDefault()}
          onClick={() => pick("")}
          aria-pressed={current === ""}
          className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${current === "" ? "bg-sky-50 text-sky-700" : "text-zinc-600 hover:bg-zinc-50"}`}
        >
          无图标
        </button>
      </div>
    </div>,
    document.body,
  );
}
