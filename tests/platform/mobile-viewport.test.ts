// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAppViewportCssVariables } from "@/components/shell/app-shell/use-visual-viewport";

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
    expect(shell).toContain("useVisualViewportCssVariables(shellRef, appShellActive)");
    expect(shell).toContain('className="app-shell-frame flex flex-col');
    expect(drawer).toContain('className="app-shell-bottom-drawer fixed');
    expect(css).toContain("height: var(--app-visual-viewport-height, 100dvh)");
    expect(css).toContain("top: var(--app-visual-viewport-offset-top, 0px)");
    expect(css).toMatch(/height: 4rem;\s+height: calc\(4rem \+ env\(safe-area-inset-top\)\)/);
    expect(css).toMatch(/padding-right: 1\.25rem;\s+padding-right: max\(1\.25rem, env\(safe-area-inset-right\)\)/);
    expect(css).toContain("padding-bottom: env(safe-area-inset-bottom)");
  });
});
