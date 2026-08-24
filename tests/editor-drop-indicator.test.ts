// @vitest-environment jsdom
// 拖拽落点指示线的配置回归测试。
//
// 这是个「改回默认值也一切正常、只是看不见了」的配置——没有测试兜着就会在
// 某次清理里被无声还原，而症状（拖起来了但不知道落在哪）不会让任何自动化
// 报警。所以这里同时断言两件事：我们的配置确实生效、且内建默认确实是看不见
// 的那一组（后者是反证——它证明这份配置不是多余的）。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { DROP_INDICATOR_OPTIONS, DROP_INDICATOR_DEFAULTS } from "@/lib/editor-drop-indicator";

/** 取 dropcursor 扩展的实际生效选项。注意大小写：StarterKit 的选项键是
 *  小写 `dropcursor`，扩展自身的 name 却是 `dropCursor` */
function dropCursorOptions(editor: Editor) {
  return editor.extensionManager.extensions.find(x => x.name === "dropCursor")?.options as
    | { width: number; color: string | undefined; class: string | undefined }
    | undefined;
}

describe("拖拽落点指示线", () => {
  it("配置确实传到了 dropcursor 扩展", () => {
    const e = new Editor({
      extensions: [StarterKit.configure({ dropcursor: { ...DROP_INDICATOR_OPTIONS } })],
      content: "甲",
    });
    const opts = dropCursorOptions(e);
    expect(opts).toBeDefined();
    expect(opts!.width).toBe(DROP_INDICATOR_OPTIONS.width);
    expect(opts!.color).toBe(DROP_INDICATOR_OPTIONS.color);
    expect(opts!.class).toBe(DROP_INDICATOR_OPTIONS.class);
    e.destroy();
  });

  // 反证：证明上面那条不是白配的
  it("内建默认是看不见的那一组 —— 1px + currentColor + 无 class", () => {
    const e = new Editor({ extensions: [StarterKit], content: "甲" });
    const opts = dropCursorOptions(e);
    expect(opts!.width).toBe(DROP_INDICATOR_DEFAULTS.width);
    expect(opts!.color).toBe(DROP_INDICATOR_DEFAULTS.color);
    expect(opts!.class).toBeUndefined();
    e.destroy();
  });

  it("我们的配置与默认在三个维度上都不同（宽度/颜色/可挂样式）", () => {
    expect(DROP_INDICATOR_OPTIONS.width).toBeGreaterThan(DROP_INDICATOR_DEFAULTS.width);
    expect(DROP_INDICATOR_OPTIONS.color).not.toBe(DROP_INDICATOR_DEFAULTS.color);
    // class 是 CSS 的挂载点（圆头 + 光晕）；没有它 CSS 里那几条规则全部落空
    expect(DROP_INDICATOR_OPTIONS.class).toBeTruthy();
  });

  it("dropcursor 插件真的进了 state（没被 StarterKit 的 false 分支关掉）", () => {
    const e = new Editor({
      extensions: [StarterKit.configure({ dropcursor: { ...DROP_INDICATOR_OPTIONS } })],
      content: "甲",
    });
    const off = new Editor({ extensions: [StarterKit.configure({ dropcursor: false })], content: "甲" });
    expect(e.state.plugins.length).toBeGreaterThan(off.state.plugins.length);
    expect(dropCursorOptions(off)).toBeUndefined();
    e.destroy(); off.destroy();
  });
});
