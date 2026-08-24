"use client";

// 块浮动条（块结构编辑器 步骤 3）—— 整块选中时浮出的块级操作条。
//
// 这同时是「点手柄 → 块菜单」（调研 §2.6 ③）和「块选中浮动条」（§5.2 第 3 项
// 末句：内容按"选中的是文本还是整块"切换两套）的**同一个实现**：点 ⠿ 手柄
// 落 NodeSelection → 本条自动浮出。不需要另造一个由手柄点击驱动的弹层，
// 「选中态」就是那两套内容的分派依据。
//
// 与文本浮动条互斥：那边 shouldShow 见 NodeSelection 就退场，这边只认
// NodeSelection。两条永不同时在场。

import { useState, useEffect } from "react";
import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import {
  getSelectedBlock, moveBlock, duplicateBlock, deleteBlock,
  turnInto, canTurnInto, isColumnGroup, changeColumnCount, equalizeColumns,
  findColumnGroup, selectColumnGroup,
  TURN_INTO,
} from "@/lib/editor-block-ops";

function Btn({
  onClick, title, children, danger,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
      className={`px-2 py-1 rounded text-sm font-medium transition-colors ${
        danger
          ? "text-red-300 hover:bg-red-900/40 hover:text-red-200"
          : "text-zinc-200 hover:bg-zinc-700 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="w-px bg-zinc-700 mx-1 self-stretch" />;
}

export default function BlockBubbleMenu({ editor }: { editor: Editor | null }) {
  const [turnOpen, setTurnOpen] = useState(false);
  // 选区一变就收起转换面板——否则换了块它还开着，作用对象已经不是用户以为的那个
  const sel = editor?.state.selection;
  useEffect(() => { setTurnOpen(false); }, [sel]);

  if (!editor) return null;

  const block = getSelectedBlock(editor);
  // 分栏操作对「栏内的块」也要给——手柄不再把分栏组本身作为目标了，
  // 组只能靠「整组」按钮选中，所以这里必须沿祖先够得着
  const group = findColumnGroup(editor);
  const selectedIsGroup = isColumnGroup(block?.node ?? null);

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="blockBubbleMenu"
      appendTo={() => document.body}
      options={{
        placement: "top-start",
        strategy: "fixed",
        offset: 8,
        flip: true,
        shift: { padding: 8 },
      }}
      shouldShow={({ editor: ed, state }) =>
        ed.isEditable && state.selection instanceof NodeSelection}
      className="relative flex items-stretch gap-0.5 px-1.5 py-1 rounded-lg bg-zinc-800 shadow-xl border border-zinc-700 z-[9999]"
    >
      {canTurnInto(block?.node ?? null) && (
        <>
          <Btn onClick={() => setTurnOpen(o => !o)} title="转换类型">转换 ▾</Btn>
          {turnOpen && (
            <div className="absolute left-0 top-full mt-1 py-1 min-w-[140px] rounded-lg bg-zinc-800 shadow-xl border border-zinc-700">
              {TURN_INTO.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  onMouseDown={e => {
                    e.preventDefault();
                    turnInto(editor, opt.id);
                    setTurnOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 hover:text-white"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <Sep />
        </>
      )}

      {group && (
        <>
          {!selectedIsGroup && (
            <Btn onClick={() => selectColumnGroup(editor)} title="选中整个分栏组（之后上移/复制/删除作用于整组）">
              整组
            </Btn>
          )}
          <Btn onClick={() => changeColumnCount(editor, 1)} title="增加一栏">＋栏</Btn>
          <Btn onClick={() => changeColumnCount(editor, -1)} title="减少一栏（从末尾）">－栏</Btn>
          <Btn onClick={() => equalizeColumns(editor)} title="各栏均分">均分</Btn>
          <Sep />
        </>
      )}

      <Btn onClick={() => moveBlock(editor, -1)} title="上移">↑</Btn>
      <Btn onClick={() => moveBlock(editor, 1)} title="下移">↓</Btn>
      <Btn onClick={() => duplicateBlock(editor)} title="复制整块">⧉</Btn>
      <Sep />
      <Btn onClick={() => deleteBlock(editor)} title="删除整块" danger>🗑</Btn>
    </BubbleMenu>
  );
}
