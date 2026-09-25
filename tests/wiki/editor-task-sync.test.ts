// @vitest-environment jsdom
// 文档任务项同步（#670）编辑器侧纯逻辑：在真实 schema（StarterKit + 任务列表 +
// contentMention）上跑——找任务项、取标题、写引用、序列化形态。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "tiptap-markdown";
import { MarkdownContentMentionExt } from "@/lib/editor/tiptap-content-mention";
import { findTaskItemContext, insertTaskMention, taskBarLayout } from "@/lib/editor/editor-task-sync";

function makeEditor(content: string) {
  return new Editor({
    extensions: [StarterKit, Markdown, TaskList, TaskItem.configure({ nested: true }), MarkdownContentMentionExt],
    content,
  });
}
const md = (editor: Editor) =>
  (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();

describe("findTaskItemContext", () => {
  it("光标在任务项里 → 标题原样 trim，不剥尾巴（#379 的正则会把「·」咬掉）", () => {
    const editor = makeEditor("- [ ] 需要陈雨 review ·");
    editor.commands.setTextSelection(4);
    const ctx = findTaskItemContext(editor)!;
    expect(ctx.title).toBe("需要陈雨 review ·");
    expect(ctx.taskId).toBeNull();
    editor.destroy();
  });

  it("不在任务项 / 选区非空 → null", () => {
    const editor = makeEditor("普通段落\n\n- [ ] 任务");
    editor.commands.setTextSelection(2);
    expect(findTaskItemContext(editor)).toBeNull();
    const size = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: size - 4, to: size - 2 });
    expect(findTaskItemContext(editor)).toBeNull();
    editor.destroy();
  });

  it("已同步的行：认出 task 引用，标题不含 chip", () => {
    const editor = makeEditor("- [ ] 装台 [#](/__cm__/task/tr_1)");
    editor.commands.setTextSelection(4);
    const ctx = findTaskItemContext(editor)!;
    expect(ctx.taskId).toBe("tr_1");
    expect(ctx.title).toBe("装台");
    editor.destroy();
  });

  it("嵌套子任务项各算各的（光标在子项 → 子项）", () => {
    const editor = makeEditor("- [ ] 父任务\n  - [ ] 子任务 [#](/__cm__/task/tr_child)");
    const size = editor.state.doc.content.size;
    editor.commands.setTextSelection(size - 6);
    const ctx = findTaskItemContext(editor)!;
    expect(ctx.title).toBe("子任务");
    expect(ctx.taskId).toBe("tr_child");
    editor.destroy();
  });
});

describe("insertTaskMention", () => {
  it("写入方言形态 [#](/__cm__/task/<id>)——不是站内链接、不冻显示文字", () => {
    const editor = makeEditor("- [ ] 需要陈雨 review");
    editor.commands.setTextSelection(4);
    const before = findTaskItemContext(editor)!;
    expect(insertTaskMention(editor, before.pos, "tr_1", "需要陈雨 review · 待处理")).toBe(true);
    const out = md(editor);
    expect(out).toContain("需要陈雨 review [#](/__cm__/task/tr_1)");
    expect(out).not.toContain("/tasks/tr_1");
    expect(out).not.toContain("打开任务");
    const after = findTaskItemContext(editor)!;
    expect(after.taskId).toBe("tr_1");
    expect(after.title).toBe("需要陈雨 review");
    editor.destroy();
  });

  it("已含 task 引用的行不重复同步", () => {
    const editor = makeEditor("- [ ] 装台");
    editor.commands.setTextSelection(3);
    const ctx = findTaskItemContext(editor)!;
    expect(insertTaskMention(editor, ctx.pos, "tr_1", "装台")).toBe(true);
    expect(insertTaskMention(editor, ctx.pos, "tr_2", "装台")).toBe(false);
    expect(md(editor).match(/__cm__\/task\//g)).toHaveLength(1);
    editor.destroy();
  });

  it("位置不是任务项 → false，文档不动", () => {
    const editor = makeEditor("- 普通项");
    const before = md(editor);
    expect(insertTaskMention(editor, 0, "tr_1", "x")).toBe(false);
    expect(md(editor)).toBe(before);
    editor.destroy();
  });

  it("引用只落在首段末尾，不进嵌套子列表", () => {
    const editor = makeEditor("- [ ] 父任务\n  - [ ] 子任务");
    editor.commands.setTextSelection(4);
    const ctx = findTaskItemContext(editor)!;
    expect(ctx.title).toBe("父任务");
    insertTaskMention(editor, ctx.pos, "tr_p", "父任务");
    const out = md(editor);
    expect(out).toMatch(/父任务 \[#\]\(\/__cm__\/task\/tr_p\)\n/);
    expect(out).toContain("子任务");
    expect(out.indexOf("tr_p")).toBeLessThan(out.indexOf("子任务"));
    editor.destroy();
  });
});

describe("taskBarLayout", () => {
  const vp = { width: 1200, height: 800 };
  it("默认贴在行上方", () => {
    const l = taskBarLayout({ left: 100, top: 300, bottom: 324 }, vp, { barHeight: 32, gap: 6 });
    expect(l).toEqual({ left: 100, top: 262, placement: "above" });
  });
  it("顶部放不下 → 行下方", () => {
    const l = taskBarLayout({ left: 100, top: 20, bottom: 44 }, vp, { barHeight: 32, gap: 6 });
    expect(l.placement).toBe("below");
    expect(l.top).toBe(50);
  });
  it("靠右夹回视口", () => {
    const l = taskBarLayout({ left: 1100, top: 300, bottom: 324 }, vp, { barWidth: 360, padding: 8 });
    expect(l.left).toBe(1200 - 360 - 8);
  });
});

describe("接线（mock 遮不住的那一层）", () => {
  it("SmartTextarea 在 markdown 面按 taskSync 挂浮条；wiki 整页开了 taskSync", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf8");
    expect(src).toMatch(/markdown && taskSync && !readOnly && contentMention && \(/);
    expect(src).toContain("<TaskSyncMenu editor={editor}");
    const wiki = readFileSync("components/wiki/WikiDocClient.tsx", "utf8");
    expect(wiki).toMatch(/contentMention=\{\{ productionId \}\}\n\s+taskSync\n/);
  });
  it("任务详情页挂了 task 反向链接面板", () => {
    const src = readFileSync("components/ops/ReqDetailClient.tsx", "utf8");
    expect(src).toContain('<RelatedWikiChips productionId={productionId} entityType="task" entityId={req.id} />');
  });
});
