// @vitest-environment jsdom
//
// #702：手机底栏保持四个业务导航位，AI 是按档位出现的紧凑中央操作位；
// 对话面板在窄屏覆盖整个视口，收起只隐藏、不卸载正在运行的会话。
import { act, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Production, ShellSession } from "@/components/shell/app-shell/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollTo = vi.fn();

const navigation = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ href, children, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onClick?.(event);
    }}>{children}</a>
  ),
}));
vi.mock("@/components/shell/SearchBar", () => ({ default: () => null }));
vi.mock("@/components/perm/PageActivationGate", () => ({ default: () => null }));
vi.mock("@/components/agent/AgentPopout", () => ({
  default: ({ open }: { open: boolean }) => <div data-agent-popout data-open={String(open)} />,
}));
vi.mock("@/components/shell/app-shell/use-shell-badges", () => ({
  useShellBadges: () => ({ unreadCount: 0, pendingTasks: 0, unreadReports: 0, cueWarnings: 0 }),
}));
vi.mock("@/components/shell/app-shell/use-production-toolbar-stage", () => ({
  useProductionToolbarStage: () => ({
    productionHeaderStage: 0,
    productionToolbarStage: 0,
    productionToolbarHasStoredControls: false,
    topbarRef: { current: null },
    topOverflowRef: { current: null },
    topOverflowOpen: false,
    setTopOverflowOpen: vi.fn(),
    topOverflowMenu: { anchorRef: { current: null }, menuRef: { current: null }, style: {} },
    productionSearchPath: null,
    handleProductionSearchOpenChange: vi.fn(),
    productionToolbarContext: {
      stage: 0,
      closeOverflow: vi.fn(),
      overflowOpen: false,
      hasStoredControls: false,
      setHasStoredControls: vi.fn(),
    },
  }),
}));
vi.mock("@/components/shell/app-shell/use-sidebar-fold", () => ({
  useSidebarFold: () => ({
    generalSidebarFolded: false,
    setGeneralSidebarFolded: vi.fn(),
    productionSidebarOverlayOpen: false,
    productionSidebarFolded: false,
    productionSidebarContentFolded: false,
    toggleScriptProductionSidebar: vi.fn(),
  }),
}));

import AppShell from "@/components/shell/AppShell";
import MobileAiAction from "@/components/shell/app-shell/MobileAiAction";
import MobileTab from "@/components/shell/app-shell/MobileTab";

const session: ShellSession = { userId: "u1", name: "测试成员", avatarUrl: null };
const productions: Production[] = [
  { id: "pro1", name: "专业档项目", archivedAt: null, roles: ["成员"], firstTag: null, canAdmin: true, avatarUrl: null, planAi: true, planAdvancedPerms: true },
  { id: "free1", name: "免费档项目", archivedAt: null, roles: ["成员"], firstTag: null, canAdmin: true, avatarUrl: null, planAi: false, planAdvancedPerms: false },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  navigation.pathname = "/";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mobileNav(): HTMLElement {
  return Array.from(container.querySelectorAll("nav"))
    .find((nav) => nav.classList.contains("lg:hidden"))!;
}

describe("#702 手机 AI 入口", () => {
  it("用固定宽度圆形按钮表达独立操作，打开态可被辅助技术识别", () => {
    const onClick = vi.fn();
    act(() => root.render(<MobileAiAction open onClick={onClick} />));

    const button = container.querySelector<HTMLButtonElement>("button[data-ai-toggle]")!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("收起 AI 助手");
    expect(button.parentElement?.className).toContain("w-12");
    act(() => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("内容链接也执行关闭 AI 的回调，再交给路由导航", () => {
    const onClick = vi.fn();
    act(() => root.render(
      <MobileTab label="今日" symbol="⌂" active={false} href="/" onClick={onClick} />,
    ));

    act(() => container.querySelector<HTMLAnchorElement>("a")!.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each([
    ["项目外", "/", true],
    ["专业档项目", "/production/pro1", true],
    ["专业档配置中心", "/production/pro1/admin", true],
    ["免费档项目", "/production/free1", false],
  ] as const)("%s 按真实语境决定是否显示 AI 入口", (_label, pathname, expected) => {
    navigation.pathname = pathname;
    act(() => root.render(
      <AppShell key={pathname} session={session} productions={productions}>
        <div>正文</div>
      </AppShell>,
    ));

    expect(!!mobileNav().querySelector("button[data-ai-toggle]")).toBe(expected);
  });

  it("点击手机 AI 入口会打开同一 AppShell 中持续挂载的面板", () => {
    navigation.pathname = "/production/pro1";
    act(() => root.render(
      <AppShell session={session} productions={productions}>
        <div>正文</div>
      </AppShell>,
    ));

    expect(container.querySelector("[data-agent-popout]")?.getAttribute("data-open")).toBe("false");
    act(() => mobileNav().querySelector<HTMLButtonElement>("button[data-ai-toggle]")!.click());
    expect(container.querySelector("[data-agent-popout]")?.getAttribute("data-open")).toBe("true");
  });
});
