// @vitest-environment jsdom
//
// #652：路由骨架屏只有灰条脉动，用户第一眼以为页面渲染坏了。钉住三件事：
// 骨架上有可见的「正在打开「××」…」（名字来自当前 pathname）、没收录的路径也有
// 「正在打开…」、剧本页的客户端加载态渲染的是同一个骨架（两段等待画面不换样子）。
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/production/p1/script";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import PageSkeleton from "@/components/ui/PageSkeleton";

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

describe("#652 PageSkeleton 表意「加载中」", () => {
  it("可见文案带目标页名，转圈在前，容器仍是 role=status", () => {
    pathname = "/production/p1/script";
    act(() => { root.render(<PageSkeleton />); });
    expect(container.textContent).toContain("正在打开「剧本」…");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    const status = container.querySelector("[role=status]")!;
    expect(status.getAttribute("aria-busy")).toBe("true");
    // 有了可见文案就不再需要 aria-label 兜底
    expect(status.getAttribute("aria-label")).toBeNull();
    // 路由 fallback 走延迟淡入
    expect(status.classList.contains("skeleton-page")).toBe(true);
  });

  it("没收录的路径退回「正在打开…」", () => {
    pathname = "/production/p1/whatever";
    act(() => { root.render(<PageSkeleton />); });
    expect(container.textContent).toContain("正在打开…");
    expect(container.textContent).not.toContain("「");
  });

  it("instant：跳过延迟淡入（给 RSC 换页后紧接着的第二段等待用）", () => {
    act(() => { root.render(<PageSkeleton instant />); });
    expect(container.querySelector("[role=status]")!.classList.contains("skeleton-page")).toBe(false);
  });

  it("剧本页的客户端加载态渲染的是同一个骨架（静态断言）", () => {
    const src = readFileSync("components/script/ScriptEditor.tsx", "utf8");
    expect(src).toMatch(/loadState === "loading"\)\s*return <PageSkeleton instant \/>;/);
    expect(src).not.toContain("加载中...");
  });

  it("两个路由段的 loading.tsx 仍用 PageSkeleton（静态断言）", () => {
    for (const f of ["app/production/[id]/loading.tsx", "app/my/loading.tsx"]) {
      expect(readFileSync(f, "utf8")).toContain("<PageSkeleton />");
    }
  });
});
