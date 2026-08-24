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

/** 表格内部结构只能整表拖，不能把行/单元格拖出去 */
const UNDRAGGABLE = new Set(["tableRow", "tableCell", "tableHeader"]);

/**
 * 分栏里的拖拽单位是**栏**，不是栏里的块（与飞书一致，见
 * lib/tiptap-column-editing.ts）。所以在分栏组内部只允许一种目标：栏本身。
 *
 * 不定死的话，命中评分会在「栏里的块」「栏」「整个分栏组」之间摇摆——同一个
 * 位置有时拽走一段、有时拽走整组，是实测到的不确定行为。
 *
 * 排除整组也是刻意的：组本身不给手柄。要整组移动/删除，用块浮动条上的
 * 「整组」按钮先把选中提升到组。
 */
function scoreForColumns({ node, $pos }: { node: PMNode; $pos: { depth: number; node: (d: number) => PMNode } }): number {
  const name = node.type.name;
  if (name === "columnGroup") return 1000;
  if (name === "column") return 0; // 要的就是它
  // 其余节点：只要祖先里有栏，就让位给那个栏
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === "column") return 1000;
  }
  return 0;
}

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
    // 按 pos 重新取一次节点，不吃 onNodeChange 存下来的那份快照——协作回灌或
    // 自己刚跑完一个块操作之后，旧 nodeSize 可能已经不对了，据此算出的落点
    // 会插到别的块中间
    const fresh = editor.state.doc.nodeAt(target.pos);
    if (!fresh) return;
    // 目标是一整栏时，「在下方插入」的意思是**在这一栏内追加一块**——
    // 插到栏后面是插进 columnGroup 里，而组的 content 是 `column column+`，
    // 放个段落进去直接违反 schema
    const after = fresh.type.name === "column"
      ? target.pos + fresh.nodeSize - 1
      : target.pos + fresh.nodeSize;
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
        rules: [
          { id: "clickin-undraggable", evaluate: ({ node }) => (UNDRAGGABLE.has(node.type.name) ? 1000 : 0) },
          { id: "clickin-column-unit", evaluate: scoreForColumns },
        ],
      }}
      onNodeChange={({ node, pos }) => setTarget({ node, pos })}
      // 刻意**不传** computePositionConfig：官方默认就是 left-start/absolute，
      // 而它进了组件的 useEffect 依赖数组——传一个行内对象字面量等于每次渲染
      // 都换身份，插件会被反复 unregister/register
      className="wiki-block-handle"
    >
      {/* 两个都**不是** <button>：WebKit 里 draggable 祖先内的原生按钮会吃掉
          mousedown 手势，dragstart 根本不触发（Chrome 无此问题，实测 Safari
          独有）。用 span + role=button 保住可访问性，同时不挡拖拽。
          动作一律走 onClick 而不是 onMouseDown —— 浏览器在真的发生拖拽后会
          抑制 click，于是「点=选中/插入、拖=移动」天然分流；而 mousedown 里
          做事（尤其 preventDefault 或 editor.focus() 抢焦点）正是掐掉
          dragstart 的另外两种经典写法。 */}
      <span
        role="button"
        tabIndex={-1}
        onClick={insertBelow}
        title="在下方插入块"
        className="wiki-block-handle-btn"
      >＋</span>
      <span
        role="button"
        tabIndex={-1}
        onClick={selectBlock}
        title="拖动排序 / 点击选中整块"
        className="wiki-block-handle-btn wiki-block-handle-grip"
      >⠿</span>
    </DragHandle>
  );
}
