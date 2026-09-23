// @vitest-environment jsdom
//
// #651：顶栏「切换项目」点另一个项目后，直到目标 RSC payload 回来前按钮纹丝不动，
// 用户以为没点上就连点。这里钉住在途态三件事：按钮立刻换成目标名 + 转圈、
// 目标 href 报给 NavPendingContext（侧栏离开旧项目高亮）、落地后撤回。
//
// App Router 的 router.push 在 startTransition 里会让路由状态更新挂起，
// 直到 payload 回来才提交。替身里用一个会 suspend 的门模拟同一件事：
// push → 门进入 suspend；resolve → 门放行 = 导航落地。
import { act, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import ProjectSwitcher from "@/components/shell/app-shell/ProjectSwitcher";
import { NavPendingContext } from "@/components/shell/app-shell/nav-pending";
import type { Production } from "@/components/shell/app-shell/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let gate: { suspend: () => void; resolved: boolean };
let promise: Promise<void>;
let resolvePromise: () => void;

function Gate({ children }: { children: React.ReactNode }) {
  const [suspended, setSuspended] = useState(false);
  gate.suspend = () => setSuspended(true);
  if (suspended && !gate.resolved) throw promise;
  return <>{children}</>;
}

const push = vi.fn((href: string) => { void href; gate.suspend(); });
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

// 弹窗内部不是被测对象：替身只暴露一个按钮，点它 = 服务端已建好项目、回调 onCreated(id)。
vi.mock("@/components/account/NewProductionModal", () => ({
  default: ({ onCreated }: { onCreated: (id: string) => void }) => (
    <button data-testid="fake-created" onClick={() => onCreated("prod-new")}>created</button>
  ),
}));

const report = vi.fn();
const bus = { href: null, report };

const P1: Production = { id: "p1", name: "剧目一", roles: ["舞监"], firstTag: null, avatarUrl: null, planAi: false, planAdvancedPerms: false } as unknown as Production;
const P2: Production = { ...P1, id: "p2", name: "剧目二", roles: ["导演"] } as unknown as Production;

let container: HTMLDivElement;
let root: Root;

function click(el: Element | null, init: MouseEventInit = {}) {
  if (!el) throw new Error("element not found");
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })); });
}
function switcherButton() { return container.querySelector("button[aria-expanded]")!; }
function menuLink(text: string): Element | null {
  return [...container.querySelectorAll("a")].find((el) => el.textContent?.includes(text)) ?? null;
}
function render(props: Partial<Parameters<typeof ProjectSwitcher>[0]> = {}) {
  act(() => {
    root.render(
      <NavPendingContext.Provider value={bus}>
        <Suspense fallback={<div data-testid="fallback" />}>
          <Gate>
            <ProjectSwitcher
              activeProductions={[P1, P2]}
              currentProduction={P1}
              currentProductionId="p1"
              canCreateProduction={false}
              {...props}
            />
          </Gate>
        </Suspense>
      </NavPendingContext.Provider>,
    );
  });
}
async function land() {
  gate.resolved = true;
  resolvePromise();
  await act(async () => { await promise; });
}

beforeEach(() => {
  push.mockClear(); refresh.mockClear(); report.mockClear();
  promise = new Promise<void>((r) => { resolvePromise = r; });
  gate = { suspend: () => {}, resolved: false };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("#651 切换项目在途态", () => {
  it("点另一个项目：按钮立刻换成目标名 + 转圈，push 走 transition，向侧栏上报目标", async () => {
    render();
    click(switcherButton());
    click(menuLink("剧目二"));

    expect(push).toHaveBeenCalledWith("/production/p2");
    // 旧 UI 保留（transition 不出 Suspense fallback），但按钮已显示目标
    expect(container.querySelector("[data-testid=fallback]")).toBeNull();
    expect(switcherButton().textContent).toContain("剧目二");
    expect(switcherButton().textContent).not.toContain("剧目一");
    expect(switcherButton().getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("[data-testid=project-switcher-spinner]")).not.toBeNull();
    // 菜单已关
    expect(menuLink("剧目二")).toBeNull();
    // 侧栏拿到「正在去哪」
    expect(report).toHaveBeenCalledWith("/production/p2", true);
    expect(report).not.toHaveBeenCalledWith("/production/p2", false);

    await land();
    expect(switcherButton().getAttribute("aria-busy")).toBeNull();
    expect(container.querySelector("[data-testid=project-switcher-spinner]")).toBeNull();
    expect(report).toHaveBeenLastCalledWith("/production/p2", false);
  });

  it("点「平台首页」：按钮显示「平台首页」，上报 /", () => {
    render();
    click(switcherButton());
    click(menuLink("平台首页"));
    expect(push).toHaveBeenCalledWith("/");
    expect(switcherButton().textContent).toContain("平台首页");
    expect(report).toHaveBeenCalledWith("/", true);
  });

  it("在途期间菜单项灰掉、再点不接受新目标", () => {
    render();
    click(switcherButton());
    click(menuLink("剧目二"));
    click(switcherButton()); // 重开菜单
    const home = menuLink("平台首页")!;
    expect(home.getAttribute("aria-disabled")).toBe("true");
    click(home);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("菜单项是真链接：普通点击被站内接管，带修饰键的点击放行给浏览器", () => {
    // React 的监听器挂在 root 容器上，先于 document 上的两个监听器跑：
    // probe 读 ProjectSwitcher 有没有 preventDefault；swallow 排在它后面，
    // 只为压掉 jsdom「没实现真跳转」的告警，不参与断言。
    let prevented: boolean | null = null;
    const probe = (e: Event) => { prevented = e.defaultPrevented; };
    const swallow = (e: Event) => e.preventDefault();
    document.addEventListener("click", probe);
    document.addEventListener("click", swallow);
    try {
      render();
      click(switcherButton());
      const link = menuLink("剧目二")!;
      expect(link.getAttribute("href")).toBe("/production/p2");
      click(link);
      expect(prevented).toBe(true);
      expect(push).toHaveBeenCalledTimes(1);

      click(switcherButton());
      click(menuLink("剧目一"), { metaKey: true });
      expect(prevented).toBe(false);
      expect(push).toHaveBeenCalledTimes(1);
      expect(report).not.toHaveBeenCalledWith("/production/p1", true);
    } finally {
      document.removeEventListener("click", probe);
      document.removeEventListener("click", swallow);
    }
  });

  it("新建项目落地前：目标还不在列表里，按钮仍显示当前项目、只转圈；push 先于 refresh", () => {
    render({ canCreateProduction: true });
    click(switcherButton());
    click(menuLink("新建项目") ?? [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("新建项目")) ?? null);
    click(container.querySelector("[data-testid=fake-created]"));
    expect(push).toHaveBeenCalledWith("/production/prod-new");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(push.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
    expect(switcherButton().textContent).toContain("剧目一");
    expect(container.querySelector("[data-testid=project-switcher-spinner]")).not.toBeNull();
    expect(report).toHaveBeenCalledWith("/production/prod-new", true);
  });
});
