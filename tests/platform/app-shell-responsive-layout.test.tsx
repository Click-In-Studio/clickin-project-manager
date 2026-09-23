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
    expect(button.style.height).toBe("38px");
    expect(button.style.padding).toBe("6px 9px");
    expect(button.style.minWidth).toBe("112px");
    expect(button.style.maxWidth).toBe("148px");
    expect(button.style.width).toBe("clamp(112px, 31vw, 148px)");
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
