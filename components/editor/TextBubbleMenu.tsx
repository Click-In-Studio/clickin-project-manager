"use client";

// 选中浮动条 —— 选中文字、或选中表格行列时浮出的操作条。
//
// **两种选中共用同一条浮动条、同一套操作**（components/editor/EditorOps），
// 表格那边只是末尾多一个整行/整列删除。同一个位置、同一种交互，用户没理由
// 要认两个东西；实现上也不该有两份会各自漂移的按钮清单。
//
// **零块概念依赖**：只吃 Selection，不需要任何块 id（调研文档 §4.2——浮动条
// 那一行「需要哪层 id」写的是"无需 id"）。不碰 serializer，保真锁无风险。
//
// 三段式机制（调研 §2.5）：
//   ① 触发 —— shouldShow：选区非空、非 NodeSelection、不在代码块内；
//      CellSelection 单独放行（它的 from/to 是单元格坐标，按文本写的那几条
//      判断对它一条都不成立）
//   ② 定位 —— floating-ui 虚拟元素（选区 Range 天然有 getBoundingClientRect）；
//      inline 中间件专治跨行选区；appendTo=body 躲开编辑器容器的 overflow 裁剪
//      与层叠上下文
//   ③ 保选区 —— 按钮一律 onMouseDown + preventDefault，否则点击即失焦
//
// 插入类（表格/分栏/代码块/分割线）不进这里——它们属于「没有选区、想加点
// 东西」，归 `/` 指令源。NodeSelection（整块选中）也不走这里，那是手柄菜单。

import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { Editor } from "@tiptap/core";
import {
  isRowSelection, isColSelection,
  deleteSelectedColumn, deleteSelectedRow,
} from "@/lib/table-ops";
import EditorOps from "@/components/editor/EditorOps";

export default function TextBubbleMenu({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  // 表格选中态：整行/整列/整表各自对应不同的"删除什么"
  const cells = editor.state.selection instanceof CellSelection;
  const wholeRow = cells && isRowSelection(editor);
  const wholeCol = cells && isColSelection(editor);
  const del = !cells ? undefined
    : wholeRow && wholeCol
      ? { run: () => { editor.chain().focus().deleteTable().run(); }, title: "删除整张表格" }
      : wholeCol ? { run: () => { deleteSelectedColumn(editor); }, title: "删除这一列" }
        : wholeRow ? { run: () => { deleteSelectedRow(editor); }, title: "删除这一行" }
          // 只选了几个单元格：没有"整行整列"可删，删除按钮就不该出现
          : undefined;

  return (
    <BubbleMenu
      editor={editor}
      // 编辑器容器可能有 overflow:hidden（wiki 整页 frameless 外框就是），
      // 挂 body + fixed 定位是唯一稳妥解
      appendTo={() => document.body}
      options={{
        placement: "top",
        strategy: "fixed",
        offset: 8,
        flip: true,
        shift: { padding: 8 },
        inline: true, // 跨行选区取首行 rect，否则浮动条贴在整个包围盒中间
      }}
      shouldShow={({ editor: ed, state, from, to }) => {
        if (!ed.isEditable) return false;
        // 表格行列选中 —— 必须放在最前，下面那几条按文本写的判断对它不成立
        if (state.selection instanceof CellSelection) return true;
        if (from === to) return false; // 光标态不浮（含 @/#/[[ 补全进行中）
        // 整块选中 = 手柄菜单的地盘，两处操作面不许同时在场
        if (state.selection instanceof NodeSelection) return false;
        // 代码块里加粗没有意义，且 markdown 序列化会把标记当字面量写进代码
        if (ed.isActive("codeBlock")) return false;
        // 选区落在原子节点（chip / 图片）上时不给操作条
        if (state.doc.textBetween(from, to, " ").trim() === "") return false;
        return true;
      }}
      className="flex items-stretch gap-0.5 px-1.5 py-1 rounded-lg bg-zinc-800 shadow-xl border border-zinc-700 z-[9999]"
    >
      <EditorOps editor={editor} onDelete={del?.run} deleteTitle={del?.title} />
    </BubbleMenu>
  );
}
