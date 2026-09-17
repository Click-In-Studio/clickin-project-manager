// @vitest-environment jsdom
//
// #528：项目列表是 root layout SSR 下发的 props，App Router 软导航不重渲 layout。
// 新建项目后只 router.push 的话，侧栏切换器里没有新项目、AppShell 也找不到当前项目，
// 非手动刷新不可。这里钉住两处「新建项目」入口的 onCreated 都是 push + refresh。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

// 弹窗内部（表单 + POST /api/productions）不是被测对象：替身只暴露一个按钮，
// 点它等价于「服务端已建好项目、回调 onCreated(id)」。
vi.mock("@/components/account/NewProductionModal", () => ({
  default: ({ onCreated }: { onCreated: (id: string) => void }) => (
    <button data-testid="fake-created" onClick={() => onCreated("prod-new")}>created</button>
  ),
}));

import ProjectSwitcher from "@/components/shell/app-shell/ProjectSwitcher";
import MyProjectsClient from "@/components/account/MyProjectsClient";

let container: HTMLDivElement;
let root: Root;

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
function byText(text: string): Element | null {
  // 切换器里的「新建项目」按钮前面还有个「+」图标 span，按包含匹配
  return [...container.querySelectorAll("button, a")].find((el) => el.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  push.mockClear(); refresh.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function expectPushedAndRefreshed() {
  expect(push).toHaveBeenCalledWith("/production/prod-new");
  // refresh 让 root layout 重跑，侧栏项目列表才会包含刚建的项目
  expect(refresh).toHaveBeenCalledTimes(1);
}

describe("#528 新建项目后项目列表自动刷新", () => {
  it("侧栏 ProjectSwitcher：onCreated → push + refresh", () => {
    act(() => {
      root.render(
        <ProjectSwitcher
          activeProductions={[]}
          currentProduction={null}
          currentProductionId={null}
          canCreateProduction
        />,
      );
    });
    click(container.querySelector("button[aria-expanded]"));
    click(byText("新建项目"));
    click(container.querySelector("[data-testid=fake-created]"));
    expectPushedAndRefreshed();
  });

  it("我的项目页 MyProjectsClient：onCreated → push + refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
    await act(async () => {
      root.render(<MyProjectsClient canCreate currentUserId="u1" />);
    });
    click(byText("新建项目"));
    click(container.querySelector("[data-testid=fake-created]"));
    expectPushedAndRefreshed();
  });
});
