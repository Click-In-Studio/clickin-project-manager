// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  getCollapsedCursorTextOffset,
  insertLineBreakAtTextOffset,
  setCursorAtTextOffset,
} from "@/components/script/script-editor/dom-cursor";

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe("剧本块光标与块内换行", () => {
  it("保存光标偏移后，可以在菜单抢走焦点后回到原位换行", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "甲乙";
    document.body.appendChild(editor);

    setCursorAtTextOffset(editor, 1);
    const offset = getCollapsedCursorTextOffset(editor);
    expect(offset).toBe(1);

    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    expect(insertLineBreakAtTextOffset(editor, offset)).toBe(true);
    expect(editor.innerHTML).toBe("甲<br>乙");
    expect(getCollapsedCursorTextOffset(editor)).toBe(2);
  });

  it("没有可恢复的光标时在块末换行", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "甲乙";
    document.body.appendChild(editor);

    expect(insertLineBreakAtTextOffset(editor, null)).toBe(true);
    expect(editor.innerHTML).toBe("甲乙<br>");
  });

  it("实体键盘直接换行时仍替换当前选区", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "甲乙丙";
    document.body.appendChild(editor);
    const range = document.createRange();
    range.setStart(editor.firstChild!, 1);
    range.setEnd(editor.firstChild!, 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(insertLineBreakAtTextOffset(editor)).toBe(true);
    expect(editor.innerHTML).toBe("甲<br>丙");
  });
});
