// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SmartTextarea from "@/components/editor/SmartTextarea";

let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
const onInitialRoundTrip = vi.fn();
const onMentionsChange = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom 没有文字范围布局；本测试只验证存储与节点，不验证滚动位置。
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  onChange.mockClear();
  onInitialRoundTrip.mockClear();
  onMentionsChange.mockClear();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("人员提及往返不应发网络请求"); }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});
async function mount(value: string, markdown: boolean, key = "first") {
  await act(async () => root.render(
    <SmartTextarea key={key} value={value} markdown={markdown} onChange={onChange}
      onInitialRoundTrip={onInitialRoundTrip}
      memberMention={{ members: [{ userId: "u_1", name: "张三" }], onMentionsChange }} />,
  ));
  // tiptap 的 onCreate 在定时任务中发出；等它完成后再验证保存路径。
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function chip() {
  return host.querySelector<HTMLElement>('[data-type="atMention"]');
}

describe("SmartTextarea 人员提及实际往返", () => {
  it.each([true, false])("markdown=%s：加载为人员节点，编辑保存并重载后 ID 与姓名仍保留", async markdown => {
    const body = "请 [@张三](/__cm__/user/u_1) 跟进";
    await mount(body, markdown);
    expect(chip()?.dataset.id).toBe("u_1");
    expect(chip()?.dataset.label).toBe("张三");
    expect(chip()?.textContent).toBe("@张三");
    expect(onInitialRoundTrip).toHaveBeenCalledWith(body);
    const editor = (host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
    await act(async () => editor.commands.insertContentAt(editor.state.doc.content.size - 1, " 完成"));
    expect(onChange).toHaveBeenLastCalledWith(`${body} 完成`);
    expect(onMentionsChange).toHaveBeenLastCalledWith([{ userId: "u_1", name: "张三" }]);
    await mount(onChange.mock.calls.at(-1)![0], markdown, "reload");
    expect(chip()?.dataset.id).toBe("u_1");
    expect(chip()?.dataset.label).toBe("张三");
    expect(onInitialRoundTrip).toHaveBeenLastCalledWith(`${body} 完成`);
    expect(fetch).not.toHaveBeenCalled();
  });
});
