"use client";

// 浮动条的「操作」组 —— 选中文字和选中表格行列时**用的是同一套**，
// 后者只是末尾多一个整行/整列删除。
//
// 抽成一个组件而不是在两处各写一遍：它们本来就是同一件事（"对当前选中做点
// 什么"），差异只有一个按钮。各写一遍的下场早有先例——同一个块类型在插入菜单
// 和转换菜单里长出两副样子（见 lib/editor-block-types 的由来）。
//
// 顺序按飞书：段落格式 → 加粗 → 删除线 → 斜体 → 行内代码 →（删除）。
//
// **没有下划线**：markdown 没有下划线这个构造，tiptap 会把它序列化成裸
// `<u>` HTML，而只读渲染端（WikiMarkdown）不挂 rehype-raw，react-markdown 会
// 把 raw 节点转成纯文本——读者看到的是字面的 `<u>甲</u>`。飞书能有是因为它不
// 存 markdown，我们存。

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { FORMAT_ACTIONS, currentFormat } from "@/lib/editor-block-ops";
import { applyAcrossCells } from "@/lib/table-ops";
import BlockTypeIcon from "@/components/editor/BlockTypeIcon";

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

/** 段落格式（飞书那个大 T）—— 点开是一张「当前是什么、能变成什么」的清单 */
function FormatMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
  return (
    <>
      <FormatMenu editor={editor} />
      <OpsSep />
      <OpsBtn onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")} title="加粗 (⌘B)"><strong>B</strong></OpsBtn>
      <OpsBtn onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")} title="删除线"><s>S</s></OpsBtn>
      <OpsBtn onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")} title="斜体 (⌘I)"><em>I</em></OpsBtn>
      <OpsBtn onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive("code")} title="行内代码">{"</>"}</OpsBtn>
      {onDelete && (
        <>
          <OpsSep />
          <OpsBtn onClick={onDelete} danger title={deleteTitle ?? "删除"}>✕</OpsBtn>
        </>
      )}
    </>
  );
}
