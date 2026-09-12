// @vitest-environment jsdom
// 图片上传占位 decoration：挂/找/翻失败/撤 全生命周期 + 位置随编辑映射 +
// 「不进正史」不变量（decoration 不得影响 markdown 序列化）。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { UploadPlaceholder, uploadPlaceholderKey, findUploadPlaceholder } from "@/lib/tiptap-upload-placeholder";

function makeEditor(content = "<p>你好</p>") {
  return new Editor({
    extensions: [StarterKit, Markdown.configure({ breaks: true }), UploadPlaceholder],
    content,
  });
}

describe("upload placeholder decoration", () => {
  it("挂占位后可按 id 找到位置；撤后找不到", () => {
    const editor = makeEditor();
    const id = {};
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { add: { id, pos: 1, name: "a.png" } }));
    expect(findUploadPlaceholder(editor.state, id)).toBe(1);
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { remove: { id } }));
    expect(findUploadPlaceholder(editor.state, id)).toBeNull();
    editor.destroy();
  });

  it("占位位置随前方插入的文字自动跟移", () => {
    const editor = makeEditor();
    const id = {};
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { add: { id, pos: 3, name: "a.png" } }));
    // 在占位之前（pos 1）插两个字
    editor.view.dispatch(editor.state.tr.insertText("前置", 1));
    expect(findUploadPlaceholder(editor.state, id)).toBe(5);
    editor.destroy();
  });

  it("失败态：占位仍在原位（等待延时撤除），不静默消失", () => {
    const editor = makeEditor();
    const id = {};
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { add: { id, pos: 1, name: "a.png" } }));
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { fail: { id } }));
    expect(findUploadPlaceholder(editor.state, id)).toBe(1);
    editor.destroy();
  });

  it("不进正史：挂着占位时 markdown 序列化不受影响", () => {
    const editor = makeEditor("<p>正文</p>");
    const id = {};
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { add: { id, pos: 1, name: "a.png" } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((editor.storage as any).markdown.getMarkdown()).toBe("正文");
    editor.destroy();
  });

  it("多个占位互不干扰，按各自 id 撤除", () => {
    const editor = makeEditor();
    const a = {}, b = {};
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { add: { id: a, pos: 1, name: "a.png" } }));
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { add: { id: b, pos: 2, name: "b.png" } }));
    editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, { remove: { id: a } }));
    expect(findUploadPlaceholder(editor.state, a)).toBeNull();
    expect(findUploadPlaceholder(editor.state, b)).toBe(2);
    editor.destroy();
  });
});
