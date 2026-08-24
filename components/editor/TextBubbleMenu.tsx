"use client";

// 文本浮动条（块结构编辑器 步骤 2 上半）—— 选中文字即浮出的格式条。
//
// **零块概念依赖**：只吃 Selection/Range，不需要任何块 id（调研文档 §4.2——
// 浮动条那一行「需要哪层 id」写的是"无需 id"）。因此它不碰 serializer，
// 存储形态零改动，保真锁无风险。
//
// 三段式机制（调研 §2.5）：
//   ① 触发 —— shouldShow：选区非空、非 NodeSelection、不在代码块内
//   ② 定位 —— floating-ui 虚拟元素（选区 Range 天然有 getBoundingClientRect）；
//      inline 中间件专治跨行选区；appendTo=body 躲开编辑器容器的 overflow 裁剪
//      与层叠上下文
//   ③ 保选区 —— 按钮必须在 onMouseDown 里 preventDefault，否则点击即失焦
//
// 内容只放**文本级**能力（marks + 块类型切换）。插入类（表格/分栏/代码块/
// 分割线）不进这里——它们属于「无选区时想加点东西」，归 `/` 指令源。
// NodeSelection（整块选中）也不走这里，那是块浮动条的活儿。

import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

function Btn({
  onClick, active, title, children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // preventDefault 是命门：不拦 mousedown 就会先失焦，选区没了再执行命令等于对空气加粗
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
      className={`px-2 py-1 rounded text-sm font-medium transition-colors ${
        active ? "bg-zinc-700 text-white" : "text-zinc-200 hover:bg-zinc-700 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="w-px bg-zinc-700 mx-1 self-stretch" />;
}

export default function TextBubbleMenu({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

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
        if (from === to) return false; // 光标态不浮（含 @/#/[[ 补全进行中）
        // 整块选中 = 块浮动条的地盘，两条浮动条不许同时在场
        if (state.selection instanceof NodeSelection) return false;
        // 代码块里加粗没有意义，且 markdown 序列化会把标记当字面量写进代码
        if (ed.isActive("codeBlock")) return false;
        // 选区落在原子节点（chip / 图片）上时不给格式条
        if (state.doc.textBetween(from, to, " ").trim() === "") return false;
        return true;
      }}
      className="flex items-stretch gap-0.5 px-1.5 py-1 rounded-lg bg-zinc-800 shadow-xl border border-zinc-700 z-[9999]"
    >
      <Btn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="粗体 (⌘B)"><strong>B</strong></Btn>
      <Btn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="斜体 (⌘I)"><em>I</em></Btn>
      <Btn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")} title="删除线"><s>S</s></Btn>
      <Btn onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive("code")} title="行内代码">{"</>"}</Btn>
      <Sep />
      <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} title="二级标题">H2</Btn>
      <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} title="三级标题">H3</Btn>
      <Sep />
      <Btn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="无序列表">≡</Btn>
      <Btn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="有序列表">1.</Btn>
      <Btn onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive("taskList")} title="任务列表">☑</Btn>
      <Sep />
      <Btn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} title="引用">&ldquo;</Btn>
    </BubbleMenu>
  );
}
