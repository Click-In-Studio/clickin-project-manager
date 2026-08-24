"use client";

// 块手柄（块结构编辑器 步骤 1 + 2 下半）—— 悬停即在块左侧浮出的 ＋ 与 ⠿。
//
// **只依赖 L0 运行时 id**（调研文档 §4.1/§4.2）：手柄命中、拖拽、块选中全部走
// ProseMirror 的整数 position，没有任何持久 id，markdown **一个字节都不改**。
// 正文里那个 `^anchor` 是第四步（块级评论/块引用）的事，本轮只预留了语法位、
// 不发放（§5.3）。
//
// 单例手柄，不是每块一个（§2.6 ①）：容器上监听 mousemove → 命中鼠标所在块 →
// 把**唯一一个**手柄 DOM 移过去。官方 DragHandle 就是这套（floating-ui 定位 +
// onNodeChange 回调给出当前 hover 的 node）。

import { useState } from "react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

/** 这些节点类型不能作为拖拽目标——把它们从父结构里拖出来会直接违反 content 约束 */
const UNDRAGGABLE = new Set([
  // column 的父 columnGroup 是 `column column+`：单独拖走一栏 = 组不成立
  "column",
  // 表格内部结构只能整表拖
  "tableRow", "tableCell", "tableHeader",
]);

export default function BlockHandle({ editor }: { editor: Editor | null }) {
  const [target, setTarget] = useState<{ node: PMNode | null; pos: number }>({ node: null, pos: -1 });

  if (!editor) return null;

  /** 选中整块 —— NodeSelection 是块级操作的统一入口（复制/删除/移动都吃它） */
  function selectBlock() {
    if (!editor || target.pos < 0) return;
    const { doc } = editor.state;
    if (target.pos >= doc.content.size) return;
    editor.chain().focus().command(({ tr, dispatch }) => {
      try {
        const sel = NodeSelection.create(tr.doc, target.pos);
        if (dispatch) dispatch(tr.setSelection(sel));
        return true;
      } catch {
        return false; // pos 已失效（并发回灌改了文档）——不选，别崩
      }
    }).run();
  }

  /** 在当前块后插空段并唤起 `/`（§2.6 ④：＋ 号顺势唤起 slash 菜单） */
  function insertBelow() {
    if (!editor || !target.node || target.pos < 0) return;
    const after = target.pos + target.node.nodeSize;
    editor.chain()
      .focus()
      .insertContentAt(after, { type: "paragraph" })
      .setTextSelection(after + 1)
      // 敲一个 `/` 进去，Suggestion 插件自然接管弹出指令菜单——不需要另造一条
      // 「以编程方式打开菜单」的通路，指令面只有一个入口
      .insertContent("/")
      .run();
  }

  return (
    <DragHandle
      editor={editor}
      // 列表项、引用块内部的块也要能拖（Notion 同款），否则列表里每一条都拖不动
      nested={{
        rules: [{
          id: "clickin-undraggable",
          evaluate: ({ node }) => (UNDRAGGABLE.has(node.type.name) ? 1000 : 0),
        }],
      }}
      onNodeChange={({ node, pos }) => setTarget({ node, pos })}
      // 刻意**不传** computePositionConfig：官方默认就是 left-start/absolute，
      // 而它进了组件的 useEffect 依赖数组——传一个行内对象字面量等于每次渲染
      // 都换身份，插件会被反复 unregister/register
      className="wiki-block-handle"
    >
      <button
        type="button"
        onMouseDown={e => { e.preventDefault(); insertBelow(); }}
        title="在下方插入块"
        className="wiki-block-handle-btn"
      >＋</button>
      <button
        type="button"
        // mousedown 里选中：点击即整块选中（浮出块浮动条），拖拽由 DragHandle
        // 自己接管。preventDefault 会掐掉 dragstart，所以这里**不能**拦默认行为
        onMouseDown={selectBlock}
        title="拖动排序 / 点击选中整块"
        className="wiki-block-handle-btn wiki-block-handle-grip"
      >⠿</button>
    </DragHandle>
  );
}
