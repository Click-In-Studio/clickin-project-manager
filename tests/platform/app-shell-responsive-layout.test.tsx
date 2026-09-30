// @vitest-environment jsdom
//
// #554：窄屏头部需要收紧项目切换器；桌面侧栏滚动时，「导航」控制区必须是不透明
// sticky 层，否则下面的导航项会从标题和折叠按钮中穿透。前者用真实渲染钉尺寸，后者
// 钉 AppShell 的层叠契约（jsdom 不计算 sticky 滚动后的像素位置，浏览器验收补这一层）。
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Production } from "@/components/shell/app-shell/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/account/NewProductionModal", () => ({ default: () => null }));

import ProjectSwitcher from "@/components/shell/app-shell/ProjectSwitcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const production: Production = {
  id: "p1",
  name: "很长的演出项目名称",
  archivedAt: null,
  roles: ["舞台监督"],
  firstTag: "正式",
  canAdmin: false,
  avatarUrl: null,
  planAi: false,
  planAdvancedPerms: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderSwitcher(compact: boolean) {
  act(() => {
    root.render(
      <ProjectSwitcher
        activeProductions={[production]}
        currentProduction={production}
        currentProductionId={production.id}
        canCreateProduction={false}
        compact={compact}
      />,
    );
  });
  return container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
}

describe("#554 项目切换器窄屏收紧", () => {
  it("常规阶段保留桌面尺寸", () => {
    const button = renderSwitcher(false);
    expect(button.style.height).toBe("44px");
    expect(button.style.padding).toBe("8px 12px");
    expect(button.style.minWidth).toBe("180px");
    expect(button.style.maxWidth).toBe("280px");
    expect(button.style.width).toBe("");
  });

  it("最窄阶段限制宽度并缩小高度和间距", () => {
    const button = renderSwitcher(true);
    expect(button.style.height).toBe("36px");
    expect(button.style.padding).toBe("5px 7px");
    expect(button.style.minWidth).toBe("88px");
    expect(button.style.maxWidth).toBe("132px");
    expect(button.style.width).toBe("clamp(88px, 28vw, 132px)");
  });

  it("最窄阶段同步收紧展开区，且原生按钮与链接语义不变", () => {
    const button = renderSwitcher(true);
    expect(button.tagName).toBe("BUTTON");

    act(() => button.click());
    const home = container.querySelector<HTMLAnchorElement>('a[href="/"]')!;
    const popover = home.parentElement!;
    expect(popover.style.width).toMatch(/^min\(244px, .*100vw\)$/);
    expect(popover.style.maxWidth).toContain("100vw");
    expect(popover.style.padding).toBe("6px");
    expect(home.tagName).toBe("A");
  });
});

describe("#554 AppShell 固定导航防穿透契约", () => {
  const source = readFileSync("components/shell/AppShell.tsx", "utf8");

  it("最窄头部阶段把 compact 状态传给项目切换器", () => {
    expect(source).toContain("compact={productionHeaderStage >= 2}");
  });

  it("导航控制区同时具备 sticky、隔离层、不透明背景和明确层级", () => {
    const className = source.match(/v3 sidebarControls[\s\S]*?<div className=\{`([^`]+)`\}/)?.[1];
    expect(className).toBeDefined();
    for (const token of ["sticky", "-top-5", "z-30", "isolate", "bg-[#e8e8e1]", "min-h-[50px]"]) {
      expect(className).toContain(token);
    }
  });
});

describe("浏览器批注 2 手机竖屏顶栏", () => {
  const shellSource = readFileSync("components/shell/AppShell.tsx", "utf8");
  const globalCss = readFileSync("app/globals.css", "utf8");

  it("给圆形项目标志单独的响应式布局钩子", () => {
    expect(shellSource).toContain('className="app-shell-brand-link flex items-center gap-2.5 shrink-0"');
  });

  it("只在手机竖屏隐藏整个标志链接并释放其 flex 占位", () => {
    expect(globalCss).toMatch(
      /@media \(max-width: 639px\) and \(orientation: portrait\) \{\s*\.app-shell-brand-link \{\s*display: none;\s*\}/,
    );
  });

  it("手机竖屏同步压缩顶栏左右留白、列间距和右侧操作间距", () => {
    expect(globalCss).toMatch(/\.app-shell-topbar\.app-shell-topbar-compact \{[\s\S]*?column-gap: 0\.375rem;[\s\S]*?padding-right: max\(0\.375rem,[\s\S]*?padding-left: max\(0\.375rem,/);
    expect(globalCss).toMatch(/\.app-shell-topbar-actions \{\s*gap: 0\.375rem;\s*\}/);
    expect(shellSource).toContain("app-shell-topbar-actions");
  });
});

describe("#354 配置中心窄屏顶栏", () => {
  const source = readFileSync("components/shell/AppShell.tsx", "utf8");

  it("窄屏隐藏重复的顶栏返回入口，桌面恢复显示", () => {
    expect(source).toMatch(
      /href=\{`\/production\/\$\{productionId\}`\}[\s\S]*?className="[^"]*hidden[^"]*lg:inline-flex[^"]*"[\s\S]*?返回项目/,
    );
  });

  it("手机配置中心保留底部返回入口", () => {
    expect(source).toMatch(
      /\/\* Admin mode \*\/[\s\S]*?label="返回"[\s\S]*?href=\{`\/production\/\$\{productionId\}`\}/,
    );
  });
});

describe("共享项目工具栏入口契约", () => {
  const source = readFileSync("components/shell/AppShell.tsx", "utf8");

  it("搜索、AI、个人中心和 overflow 入口仍挂在同一顶栏", () => {
    expect(source).toContain("<SearchBar");
    expect(source).toContain("data-ai-toggle");
    expect(source).toContain("<UserMenu");
    expect(source).toContain('aria-label="更多工具"');
  });
});
