"use client";

// 块操作菜单 —— 点左侧手柄的 ⠿ 弹出（调研文档 §2.6 ③「点手柄 → 块菜单」）。
//
// 重心在手柄，不在浮动条：飞书和 Notion 现在都是「主要操作在左侧手柄完成，
// 浮动条只负责选中文字时的少量格式」。所以块级操作（转换类型 / 移动 / 复制 /
// 删除 / 分栏）全部收进这里，浮动条只剩文本格式那一条。
//
// 菜单内的每一项都作用于**当前的 NodeSelection**（点手柄时已经选中），不依赖
// 手柄自己的 hover 状态——菜单一打开鼠标就离开手柄了，手柄随即隐藏，若还读
// 它的 target 会拿到空。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import {
  getSelectedBlock, moveBlock, duplicateBlock, deleteBlock,
  turnInto, canTurnInto, isColumnGroup, changeColumnCount, equalizeColumns,
  findColumnGroup, selectColumnGroup,
  TURN_INTO,
} from "@/lib/editor-block-ops";
import BlockTypeIcon from "@/components/editor/BlockTypeIcon";

function Item({
  onClick, children, hint, danger, disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      // 菜单项一律 onMouseDown + preventDefault：不拦的话点击会先让编辑器失焦，
      // NodeSelection 随之丢失，命令执行时已经没有作用对象了
      onMouseDown={e => { e.preventDefault(); if (!disabled) onClick(); }}
      className={`w-full flex items-center gap-3 px-3 py-1.5 text-sm text-left transition-colors ${
        disabled
          ? "text-zinc-300 cursor-not-allowed"
          : danger
            ? "text-red-600 hover:bg-red-50"
            : "text-zinc-700 hover:bg-zinc-50"
      }`}
    >
      <span className="flex-1">{children}</span>
      {hint && <span className="text-[11px] font-mono text-zinc-400">{hint}</span>}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pt-2 pb-1 text-[11px] font-medium text-zinc-400">{children}</p>;
}

export default function BlockMenu({
  editor, anchor, onClose,
}: {
  editor: Editor;
  /** 手柄在视口里的矩形，菜单贴着它右下角展开 */
  anchor: DOMRect;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<"root" | "turn">("root");

  // 点外面 / Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // mousedown 用捕获阶段：菜单项自己的 onMouseDown 会 preventDefault，
    // 但事件照样冒泡，捕获阶段先跑才能正确区分"点在菜单内/外"
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const block = getSelectedBlock(editor);
  const group = findColumnGroup(editor);
  const selectedIsGroup = isColumnGroup(block?.node ?? null);
  const selectedIsColumn = block?.node.type.name === "column";

  /** 跑完就关——菜单是一次性动作面板，不是常驻工具栏 */
  const run = (fn: () => void) => { fn(); onClose(); };

  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(8, anchor.left),
    top: anchor.bottom + 6,
    zIndex: 9999,
  };

  return createPortal(
    <div
      ref={ref}
      style={style}
      className="min-w-[190px] max-h-[70vh] overflow-y-auto bg-white rounded-xl shadow-lg border border-zinc-100 py-1"
    >
      {page === "turn" ? (
        <>
          <Item onClick={() => setPage("root")}>← 返回</Item>
          <SectionLabel>转换为</SectionLabel>
          {TURN_INTO.map(opt => (
            <Item key={opt.id} onClick={() => run(() => turnInto(editor, opt.id))} hint={opt.hint}>
              {/* 与 `/` 插入菜单同一个图标片、同一张定式表：同一个块类型在
                  「新建」和「转换为」里必须长同一副样子 */}
              <span className="flex items-center gap-2.5">
                <BlockTypeIcon icon={opt.icon} />
                {opt.label}
              </span>
            </Item>
          ))}
        </>
      ) : (
        <>
          {canTurnInto(block?.node ?? null) && (
            <Item onClick={() => setPage("turn")} hint="▸">转换为</Item>
          )}

          <Item onClick={() => run(() => moveBlock(editor, -1))}>上移</Item>
          <Item onClick={() => run(() => moveBlock(editor, 1))}>下移</Item>
          <Item onClick={() => run(() => duplicateBlock(editor))}>复制</Item>

          {group && (
            <>
              <SectionLabel>分栏</SectionLabel>
              {!selectedIsGroup && (
                <Item onClick={() => run(() => selectColumnGroup(editor))}>选中整个分栏</Item>
              )}
              <Item onClick={() => run(() => changeColumnCount(editor, 1))}>增加一栏</Item>
              <Item onClick={() => run(() => changeColumnCount(editor, -1))}>减少一栏</Item>
              <Item onClick={() => run(() => equalizeColumns(editor))}>各栏均分</Item>
            </>
          )}

          <div className="my-1 h-px bg-zinc-100" />
          <Item danger onClick={() => run(() => deleteBlock(editor))}>
            {selectedIsColumn ? "删除这一栏" : "删除"}
          </Item>
        </>
      )}
    </div>,
    document.body,
  );
}
