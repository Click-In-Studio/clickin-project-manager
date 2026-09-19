// @vitest-environment jsdom

// #542：快捷键提示按平台渲染。键盘处理早就两键都认，这里只钉**文案**。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Kbd from "@/components/ui/Kbd";
import { detectMacLike, formatShortcut, useShortcutLabel } from "@/components/ui/shortcut-label";

function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  Object.defineProperty(navigator, "userAgentData", { configurable: true, value: undefined });
}

describe("formatShortcut", () => {
  it("Mac：符号连写", () => {
    expect(formatShortcut("Mod+Z", true)).toBe("⌘Z");
    expect(formatShortcut("Mod+Shift+Z", true)).toBe("⌘⇧Z");
    expect(formatShortcut("Shift+Enter", true)).toBe("⇧↵");
    expect(formatShortcut("Mod+Enter", true)).toBe("⌘↵");
  });

  it("Windows：Ctrl 加号分隔，其它键原样", () => {
    expect(formatShortcut("Mod+Z", false)).toBe("Ctrl+Z");
    expect(formatShortcut("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z");
    expect(formatShortcut("Shift+Enter", false)).toBe("Shift+Enter");
    expect(formatShortcut("Mod+Enter", false)).toBe("Ctrl+Enter");
    expect(formatShortcut("Backspace", false)).toBe("Backspace");
  });
});

describe("detectMacLike", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("按 navigator.platform 判：Win32 → false，MacIntel / iPhone → true", () => {
    setPlatform("Win32");
    expect(detectMacLike()).toBe(false);
    setPlatform("MacIntel");
    expect(detectMacLike()).toBe(true);
    setPlatform("iPhone");
    expect(detectMacLike()).toBe(true);
  });

  it("优先 userAgentData.platform（Chromium 已冻结 navigator.platform）", () => {
    setPlatform("MacIntel");
    Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { platform: "Windows" } });
    expect(detectMacLike()).toBe(false);
  });

  it("没有 navigator（SSR）→ 按 Mac", () => {
    vi.stubGlobal("navigator", undefined);
    expect(detectMacLike()).toBe(true);
  });
});

describe("<Kbd> / useShortcutLabel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("SSR 一律按 Mac 渲染（服务端快照）", () => {
    expect(renderToString(<Kbd combo="Mod+F" />)).toBe("<kbd>⌘F</kbd>");
  });

  it("Windows 客户端渲染 Ctrl 写法，className 透传", async () => {
    setPlatform("Win32");
    await act(async () => root.render(<Kbd combo="Mod+Shift+L" className="x" />));
    const kbd = container.querySelector("kbd")!;
    expect(kbd.textContent).toBe("Ctrl+Shift+L");
    expect(kbd.className).toBe("x");
  });

  it("useShortcutLabel 可直接给 placeholder 这类字符串位", async () => {
    setPlatform("Win32");
    function Probe() {
      return <textarea placeholder={`添加评论… (${useShortcutLabel("Mod+Enter")} 发布)`} />;
    }
    await act(async () => root.render(<Probe />));
    expect(container.querySelector("textarea")!.placeholder).toBe("添加评论… (Ctrl+Enter 发布)");
  });
});
