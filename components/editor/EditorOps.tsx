"use client";

// 浮动条的「操作」组 —— 选中文字和选中表格行列时**用的是同一套**，
// 后者只是末尾多一个整行/整列删除。
//
// 抽成一个组件而不是在两处各写一遍：它们本来就是同一件事（"对当前选中做点
// 什么"），差异只有一个按钮。各写一遍的下场早有先例——同一个块类型在插入菜单
// 和转换菜单里长出两副样子（见 lib/editor/editor-block-types 的由来）。
//
// 顺序按飞书：段落格式 → 加粗 → 删除线 → 斜体 → 下划线 → 行内代码 → 颜色 →（删除）。
//
// **下划线与颜色（#524）**：这里原先写着「没有下划线：markdown 没有这个构造，
// tiptap 会序列化成裸 `<u>`，只读端不挂 rehype-raw 会显示成字面标签」。那条
// 论据的前半句仍成立，后半句已被推翻——现在 `<u>` / `<span style="color:…">`
// 就是正式方言（HTML 子集，lib/editor/inline-style-dialect），只读端用
// remark-inline-style 只配对这三种 canonical 标签，不开 rehype-raw。
// 「默认颜色」是去掉标签而不是某个值，所以色板里「默认」单独一项，不画成黑块。

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { FORMAT_ACTIONS, currentFormat } from "@/lib/editor/editor-block-ops";
import { applyAcrossCells } from "@/lib/editor/table-ops";
import {
  TEXT_BG_COLORS, TEXT_COLOR_LABELS, TEXT_FG_COLORS, isTextBgColor, isTextFgColor,
} from "@/lib/editor/inline-style-dialect";
import BlockTypeIcon from "@/components/editor/BlockTypeIcon";
import { useShortcutLabel } from "@/components/ui/shortcut-label";

export function OpsBtn({
  onClick, active, title, danger, children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // preventDefault 是命门：不拦 mousedown 就会先失焦，选区没了再执行命令
      // 等于对空气加粗
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
      className={`px-2 py-1 rounded text-sm font-medium transition-colors ${
        danger
          ? "text-red-300 hover:bg-red-900/40 hover:text-red-200"
          : active
            ? "bg-zinc-700 text-white"
            : "text-zinc-200 hover:bg-zinc-700 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

export function OpsSep() {
  return <span className="w-px bg-zinc-700 mx-1 self-stretch" />;
}

/** 点外面 / Esc 关闭的下拉壳（段落格式与颜色两个下拉共用） */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

/** 段落格式（飞书那个大 T）—— 点开是一张「当前是什么、能变成什么」的清单 */
function FormatMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const now = currentFormat(editor);

  return (
    <div ref={ref} className="relative flex items-stretch">
      <OpsBtn onClick={() => setOpen(o => !o)} active={open} title={`段落格式：${now.label}`}>
        <span className="font-serif text-base leading-none">T</span>
      </OpsBtn>
      {open && (
        <div className="absolute left-0 top-full mt-1 py-1 min-w-[150px] rounded-lg bg-zinc-800 shadow-xl border border-zinc-700 z-10">
          {FORMAT_ACTIONS.map(f => (
            <button
              key={f.id}
              type="button"
              // 走 applyAcrossCells：选中一整列时，列表/任务这类命令只认一个
              // blockRange，不逐个单元格跑就只会作用到其中一格
              onMouseDown={e => { e.preventDefault(); applyAcrossCells(editor, f.run); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors ${
                f.isActive(editor) ? "text-white bg-zinc-700" : "text-zinc-200 hover:bg-zinc-700"
              }`}
            >
              <BlockTypeIcon icon={f.icon} />
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 色板一格：aria-pressed 表选中，描蓝边；swatch 里的 A 用 CSS 变量取色（hex 只在 globals.css） */
function Swatch({
  active, title, onPick, children, style,
}: {
  active: boolean; title: string; onPick: () => void; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={e => { e.preventDefault(); onPick(); }}
      style={style}
      className={`h-7 w-7 rounded-md text-sm font-semibold leading-none flex items-center justify-center border-2 transition-colors ${
        active ? "border-sky-400" : "border-transparent hover:border-zinc-500"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 字色 / 底色下拉（#524）。两排色板各带「默认」一格：默认 = unsetMark 去壳，
 * 不是写 `color:default`——所以它画成带斜线的 A，不画成黑块（黑是真实的一档）。
 */
function ColorMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const fgNow = editor.getAttributes("textColor").color as unknown;
  const bgNow = editor.getAttributes("textBackground").color as unknown;
  const fg = isTextFgColor(fgNow) ? fgNow : null;
  const bg = isTextBgColor(bgNow) ? bgNow : null;

  const pickFg = (c: typeof fg) => {
    if (c) editor.chain().focus().setTextColor(c).run();
    else editor.chain().focus().unsetTextColor().run();
    setOpen(false);
  };
  const pickBg = (c: typeof bg) => {
    if (c) editor.chain().focus().setTextBackground(c).run();
    else editor.chain().focus().unsetTextBackground().run();
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative flex items-stretch">
      <OpsBtn onClick={() => setOpen(o => !o)} active={open || !!fg || !!bg} title="字体颜色 / 背景颜色">
        {/* 触发钮本身就是当前状态的预览：A 取当前字色，底下一道取当前底色 */}
        <span className="inline-flex flex-col items-center leading-none">
          <span style={fg ? { color: `var(--text-fg-${fg})` } : undefined}>A</span>
          <span
            className="mt-0.5 h-[3px] w-4 rounded-sm"
            style={{ background: bg ? `var(--text-bg-${bg})` : "currentColor", opacity: bg ? 1 : 0.35 }}
          />
        </span>
      </OpsBtn>
      {open && (
        <div
          data-text-color-menu=""
          className="absolute left-0 top-full mt-1 px-2 py-1.5 rounded-lg bg-zinc-800 shadow-xl border border-zinc-700 z-10"
        >
          <p className="px-1 pt-0.5 pb-1 text-[11px] text-zinc-400">字体颜色</p>
          <div className="flex gap-0.5">
            <Swatch active={fg === null} title="字体颜色：默认" onPick={() => pickFg(null)}>
              <span className="relative text-zinc-200">A<span className="absolute -left-0.5 top-1/2 h-px w-4 -rotate-45 bg-zinc-400" /></span>
            </Swatch>
            {TEXT_FG_COLORS.map(c => (
              <Swatch key={c} active={fg === c} title={`字体颜色：${TEXT_COLOR_LABELS[c]}`} onPick={() => pickFg(c)}>
                <span className="rounded bg-zinc-100 px-1 py-0.5" style={{ color: `var(--text-fg-${c})` }}>A</span>
              </Swatch>
            ))}
          </div>
          <p className="px-1 pt-1.5 pb-1 text-[11px] text-zinc-400">背景颜色</p>
          <div className="flex gap-0.5">
            <Swatch active={bg === null} title="背景颜色：默认" onPick={() => pickBg(null)}>
              <span className="relative text-zinc-200">A<span className="absolute -left-0.5 top-1/2 h-px w-4 -rotate-45 bg-zinc-400" /></span>
            </Swatch>
            {TEXT_BG_COLORS.map(c => (
              <Swatch key={c} active={bg === c} title={`背景颜色：${TEXT_COLOR_LABELS[c]}`} onPick={() => pickBg(c)}>
                <span className="rounded px-1 py-0.5 text-zinc-800" style={{ background: `var(--text-bg-${c})` }}>A</span>
              </Swatch>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 浮动条的操作组。
 *
 * onDelete 给了就在末尾多一个删除按钮——那正是「选中表格行列」相对「选中文字」
 * 唯一多出来的东西。
 */
export default function EditorOps({
  editor, onDelete, deleteTitle,
}: {
  editor: Editor;
  onDelete?: () => void;
  deleteTitle?: string;
}) {
  const boldKey = useShortcutLabel("Mod+B");
  const italicKey = useShortcutLabel("Mod+I");
  const underlineKey = useShortcutLabel("Mod+U");
  return (
    <>
      <FormatMenu editor={editor} />
      <OpsSep />
      <OpsBtn onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")} title={`加粗 (${boldKey})`}><strong>B</strong></OpsBtn>
      <OpsBtn onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")} title="删除线"><s>S</s></OpsBtn>
      <OpsBtn onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")} title={`斜体 (${italicKey})`}><em>I</em></OpsBtn>
      <OpsBtn onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive("underline")} title={`下划线 (${underlineKey})`}><u>U</u></OpsBtn>
      <OpsBtn onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive("code")} title="行内代码">{"</>"}</OpsBtn>
      <ColorMenu editor={editor} />
      {onDelete && (
        <>
          <OpsSep />
          <OpsBtn onClick={onDelete} danger title={deleteTitle ?? "删除"}>✕</OpsBtn>
        </>
      )}
    </>
  );
}
