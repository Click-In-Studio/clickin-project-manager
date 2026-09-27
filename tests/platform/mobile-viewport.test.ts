// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  deriveAppViewportState,
  ensureEditableTargetVisible,
  isEditableTarget,
  useAppViewportState,
  writeAppViewportCssVariables,
} from "@/components/shell/app-shell/use-visual-viewport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("#726 移动端可见视口", () => {
  it("把 Visual Viewport 几何量发布为 App Shell CSS 变量", () => {
    const target = document.createElement("div");

    writeAppViewportCssVariables(target, { height: 612.5, offsetTop: 7.5 }, 844);

    expect(target.style.getPropertyValue("--app-visual-viewport-height")).toBe("612.5px");
    expect(target.style.getPropertyValue("--app-visual-viewport-offset-top")).toBe("7.5px");
    expect(target.style.getPropertyValue("--app-visual-viewport-bottom-inset")).toBe("224px");
  });

  it("厂商浏览器返回过大的 Visual Viewport 时使用较小的 innerHeight", () => {
    const target = document.createElement("div");

    writeAppViewportCssVariables(target, { height: 844, offsetTop: 0 }, 700);

    expect(target.style.getPropertyValue("--app-visual-viewport-height")).toBe("700px");
  });

  it("只允许 App Shell 的唯一 hook 直接读取 Visual Viewport", () => {
    const users = ["app", "components", "lib"]
      .flatMap(sourceFiles)
      .filter((path) => readFileSync(path, "utf8").includes("window.visualViewport"));

    expect(users).toEqual(["components/shell/app-shell/use-visual-viewport.ts"]);
  });

  it("根布局声明 edge-to-edge viewport，壳与浮层消费同一高度", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    const shell = readFileSync("components/shell/AppShell.tsx", "utf8");
    const drawer = readFileSync("components/shell/app-shell/BottomDrawer.tsx", "utf8");
    const css = readFileSync("app/globals.css", "utf8");

    expect(layout).toContain('viewportFit: "cover"');
    expect(layout).toContain('interactiveWidget: "resizes-visual"');
    expect(shell).toContain("useAppViewportState(appShellActive)");
    expect(shell).toContain('className="app-shell-frame flex flex-col');
    expect(drawer).toContain('className="app-shell-bottom-drawer fixed');
    expect(css).toContain("height: var(--app-visual-viewport-height, 100dvh)");
    expect(css).toContain("top: var(--app-visual-viewport-offset-top, 0px)");
    expect(css).toMatch(/height: 4rem;\s+height: calc\(4rem \+ env\(safe-area-inset-top\)\)/);
    expect(css).toMatch(/padding-right: 1\.25rem;\s+padding-right: max\(1\.25rem, env\(safe-area-inset-right\)\)/);
    expect(css).toContain("padding-bottom: env(safe-area-inset-bottom)");
  });
});

describe("#727 手机编辑态", () => {
  it("只有可编辑焦点且可见高度低于聚焦基线时判定键盘打开", () => {
    expect(deriveAppViewportState({ height: 844, offsetTop: 0 }, 844, false, null).keyboardOpen).toBe(false);
    expect(deriveAppViewportState({ height: 844, offsetTop: 0 }, 844, true, 844).keyboardOpen).toBe(false);
    expect(deriveAppViewportState({ height: 480, offsetTop: 44 }, 844, true, 844)).toMatchObject({
      visibleHeight: 480,
      editing: true,
      keyboardOpen: true,
    });
  });

  it("只把会唤起文本编辑的控件视为编辑目标", () => {
    const text = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const textarea = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");

    expect(isEditableTarget(text)).toBe(true);
    expect(isEditableTarget(checkbox)).toBe(false);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(editor)).toBe(true);
  });

  it("键盘稳定后只把越界的小型编辑控件滚进可见视口", () => {
    const shell = document.createElement("div");
    shell.className = "app-shell-frame";
    const scrollContainer = document.createElement("div");
    const input = document.createElement("input");
    scrollContainer.style.overflowY = "auto";
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 480 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 960 });
    scrollContainer.appendChild(input);
    shell.appendChild(scrollContainer);
    document.body.appendChild(shell);
    vi.spyOn(shell, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 480,
      height: 480,
      left: 0,
      right: 390,
      width: 390,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue({
      top: 64,
      bottom: 480,
      height: 416,
      left: 0,
      right: 390,
      width: 390,
      x: 0,
      y: 120,
      toJSON: () => ({}),
    });

    const getBoundingClientRect = vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      top: 500,
      bottom: 536,
      height: 36,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 500,
      toJSON: () => ({}),
    });
    // 即使 Safari 报出的 offsetTop 会让 500..536 看似仍处于 120..600 内，
    // 实际收缩后的壳只到 480；判断必须采用同坐标系的壳矩形。
    expect(ensureEditableTargetVisible(input, { height: 480, offsetTop: 120 })).toBe(true);
    expect(scrollContainer.scrollTop).toBe(68);

    getBoundingClientRect.mockReturnValue({
      top: 180,
      bottom: 216,
      height: 36,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 180,
      toJSON: () => ({}),
    });
    expect(ensureEditableTargetVisible(input, { height: 480, offsetTop: 120 })).toBe(false);
    expect(scrollContainer.scrollTop).toBe(68);

    getBoundingClientRect.mockReturnValue({
      top: 120,
      bottom: 720,
      height: 600,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 120,
      toJSON: () => ({}),
    });
    expect(ensureEditableTargetVisible(input, { height: 480, offsetTop: 120 })).toBe(false);
    expect(scrollContainer.scrollTop).toBe(68);
    shell.remove();
  });

  it("唯一 hook 卸载时清理 Visual Viewport 订阅与根节点状态", () => {
    class FakeVisualViewport extends EventTarget {
      height = 844;
      offsetTop = 0;
      counts = new Map<string, number>();
      override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
        super.addEventListener(type, listener, options);
        this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
      }
      override removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
        super.removeEventListener(type, listener, options);
        this.counts.set(type, (this.counts.get(type) ?? 0) - 1);
      }
    }
    const viewport = new FakeVisualViewport();
    const originalViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Probe() { useAppViewportState(true); return null; }

    act(() => root.render(createElement(Probe)));
    expect(viewport.counts).toEqual(new Map([["resize", 1], ["scroll", 1]]));
    expect(document.documentElement.dataset.appKeyboardOpen).toBe("false");

    act(() => root.unmount());
    expect(viewport.counts).toEqual(new Map([["resize", 0], ["scroll", 0]]));
    expect(document.documentElement.dataset.appKeyboardOpen).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--app-visual-viewport-height")).toBe("");
    container.remove();
    if (originalViewport) Object.defineProperty(window, "visualViewport", originalViewport);
    else delete (window as { visualViewport?: VisualViewport }).visualViewport;
    if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
  });

  it("底栏、抽屉、模态框和 AI 工作面消费同一编辑态", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const agent = readFileSync("components/agent/AgentPopout.tsx", "utf8");
    const drawer = readFileSync("components/shell/app-shell/BottomDrawer.tsx", "utf8");
    const modal = readFileSync("components/ui/AdminModal.tsx", "utf8");

    expect(css).toContain('html[data-app-keyboard-open="true"] .app-shell-bottom-nav');
    expect(css).toContain('html[data-app-keyboard-open="true"] .app-mobile-input-overlay');
    expect(css).toMatch(/\[contenteditable\]:not\(\[contenteditable="false"\]\) \{\s+font-size: 16px !important;/);
    expect(agent).toContain("app-mobile-input-overlay fixed inset-0");
    expect(agent).toContain("min-h-0 flex-1");
    expect(drawer).toContain("app-mobile-input-surface");
    expect(modal).toContain("app-mobile-input-overlay");
  });
});
