// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "tiptap-markdown";
import { findTaskItemContext, insertTaskLink } from "@/lib/editor-task-sync";

function makeEditor() {
  return new Editor({
    extensions: [StarterKit, Markdown, TaskList, TaskItem.configure({ nested: true })],
    content: "- [ ] 需要陈雨 review",
  });
}

describe("document task sync", () => {
  it("persists the task relation as a markdown link on the task row", () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(4);
    const before = findTaskItemContext(editor)!;
    expect(before.title).toBe("需要陈雨 review");
    expect(before.taskId).toBeNull();
    expect(insertTaskLink(editor, before.pos, "demo", "task-1")).toBe(true);
    const markdown = (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
    expect(markdown).toContain("[打开任务](/production/demo/tasks/task-1)");
    const after = findTaskItemContext(editor)!;
    expect(after.taskId).toBe("task-1");
    expect(after.title).toBe("需要陈雨 review");
    editor.destroy();
  });

  it("does not append a second task link", () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(4);
    const context = findTaskItemContext(editor)!;
    insertTaskLink(editor, context.pos, "demo", "task-1");
    insertTaskLink(editor, context.pos, "demo", "task-2");
    const markdown = (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
    expect(markdown.match(/打开任务/g)).toHaveLength(1);
    editor.destroy();
  });
});
