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
import HomeClient from "@/components/ops/HomeClient";
import PlatformTopMenu from "@/components/shell/PlatformTopMenu";
import { PLATFORM_TOP_MENU_LABELS } from "@/components/shell/app-shell/nav-config";
import AnnouncementsClient from "@/components/notify/AnnouncementsClient";
import MyTasksClient from "@/components/ops/MyTasksClient";
import MyProjectsClient from "@/components/account/MyProjectsClient";
import { ProductionToolbarContext } from "@/components/shell/ProductionTopMenu";
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
  vi.unstubAllGlobals();
});

function mobileNav(): HTMLElement {
  return Array.from(container.querySelectorAll("nav"))
    .find((nav) => nav.classList.contains("lg:hidden"))!;
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => {
      const content = button.textContent?.trim();
      return content === text || content?.includes(text);
    })!;
}

describe("平台首页标题", () => {
  it("标题完整显示在顶栏，正文直接从项目进展开始，离开首页后不残留", () => {
    act(() => root.render(
      <AppShell session={session} productions={productions}>
        <HomeClient productions={[]} myCallTimes={[]} myPendingReqs={[]} myAwaitingReqs={[]}
          myUnreadReports={[]} upcomingMilestones={[]} totalCueWarnings={0} />
      </AppShell>,
    ));

    const header = container.querySelector("header")!;
    expect(header.textContent).toContain("平台级");
    expect(header.querySelector("h1")?.textContent).toBe("我的工作");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    const workspace = container.querySelector("#workspace-scroll")!;
    expect(workspace.querySelector("h1")).toBeNull();
    expect(workspace.querySelector("h2")?.textContent).toBe("项目风险与未确认事项");

    navigation.pathname = "/production/pro1";
    act(() => root.render(
      <AppShell session={session} productions={productions}><div>项目正文</div></AppShell>,
    ));
    expect(header.textContent).not.toContain("平台级");
    expect(header.querySelector("h1")).toBeNull();
    expect(header.querySelector('[data-production-top-menu-context="我的工作"]')).toBeTruthy();
  });
});

describe("平台全量顶栏", () => {
  it("项目加载结束后仍只有一个页名，窄屏操作进入更多并可关闭菜单", async () => {
    navigation.pathname = "/my/projects";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
    const closeOverflow = vi.fn();
    const setHasStoredControls = vi.fn();
    await act(async () => root.render(
      <AppShell session={session} productions={productions}>
        <ProductionToolbarContext.Provider value={{ stage: 2, closeOverflow, overflowOpen: true,
          hasStoredControls: true, setHasStoredControls }}>
          <MyProjectsClient canCreate currentUserId={session.userId} />
        </ProductionToolbarContext.Provider>
      </AppShell>,
    ));
    expect(container.querySelector("header h1")?.textContent).toBe("我的项目");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    const overflow = container.querySelector("#production-page-toolbar-overflow-slot")!;
    expect(overflow.textContent).toContain("调整顺序");
    expect(overflow.textContent).toContain("新建项目");
    expect(setHasStoredControls).toHaveBeenCalledWith(true);
    act(() => buttonWithText(overflow, "新建项目").click());
    expect(closeOverflow).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("项目名称");
  });

  it.each(Object.entries(PLATFORM_TOP_MENU_LABELS))("%s 的标题只有顶栏一处，换页后旧标题不残留", (pathname, title) => {
    navigation.pathname = pathname;
    act(() => root.render(
      <AppShell session={session} productions={productions}>
        <PlatformTopMenu title={title} />
        <div>正文内容</div>
      </AppShell>,
    ));
    expect(container.querySelector("header h1")?.textContent).toBe(title);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("#workspace-scroll h1")).toBeNull();
    act(() => root.render(
      <AppShell session={session} productions={productions}>
        <PlatformTopMenu title="切换后的标题" />
      </AppShell>,
    ));
    expect(container.querySelector("header h1")?.textContent).toBe("切换后的标题");
  });

  it.each(["公告", "任务"])("真实%s页面将标题挂到顶栏，正文不重复渲染", (page) => {
    navigation.pathname = page === "公告" ? "/my/announcements" : "/my/tasks";
    act(() => root.render(
      <AppShell session={session} productions={productions}>
        {page === "公告"
          ? <AnnouncementsClient announcements={[]} cueWarnings={[]} initialReadIds={[]} />
          : <MyTasksClient initialTasks={[]} />}
      </AppShell>,
    ));
    expect(container.querySelector("header h1")?.textContent).toBe(page === "公告" ? "公告与风险提醒" : "我的任务");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("#workspace-scroll h1")).toBeNull();
  });
});

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

describe("手机导航入口完整性", () => {
  it("项目内用概览抽屉收纳我的工作、我的通知与审批", () => {
    navigation.pathname = "/production/pro1";
    act(() => root.render(
      <AppShell session={session} productions={productions}>
        <div>正文</div>
      </AppShell>,
    ));

    const overview = buttonWithText(mobileNav(), "⌂概览");
    act(() => overview.click());

    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links.find((link) => link.textContent?.includes("我的工作"))?.getAttribute("href")).toBe("/production/pro1");
    expect(links.find((link) => link.textContent?.includes("我的通知"))?.getAttribute("href")).toBe("/production/pro1/notifications");
    expect(links.find((link) => link.textContent?.includes("审批"))?.getAttribute("href")).toBe("/production/pro1/access-requests");
  });

  it("我抽屉补齐桌面头像菜单里的全部帮助入口", () => {
    navigation.pathname = "/production/pro1";
    act(() => root.render(
      <AppShell
        session={session}
        productions={productions}
        helpRoutes={{ "": "start/interface/navigation" }}
        latestChangelogVersion="v0.1.1"
      >
        <div>正文</div>
      </AppShell>,
    ));

    act(() => buttonWithText(mobileNav(), "我").click());

    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links.find((link) => link.textContent?.includes("本页帮助"))?.getAttribute("href")).toBe("/help/start/interface/navigation");
    expect(links.find((link) => link.textContent?.includes("使用手册"))?.getAttribute("href")).toBe("/help");
    const changelogLink = links.find((link) => link.textContent?.includes("更新日志"));
    expect(changelogLink?.getAttribute("href")).toBe("/help/changelog");
    expect(changelogLink?.textContent).toContain("新");
    expect(changelogLink?.querySelector('svg[data-me-menu-icon="changelog"]')).toBeTruthy();
    expect(buttonWithText(container, "报告问题")).toBeTruthy();
  });

  it("我抽屉的入口使用统一语义图标，不回退成单字占位符", () => {
    navigation.pathname = "/production/pro1";
    act(() => root.render(
      <AppShell session={session} productions={productions}>
        <div>正文</div>
      </AppShell>,
    ));

    act(() => buttonWithText(mobileNav(), "我").click());

    const icons = Array.from(container.querySelectorAll<SVGElement>("svg[data-me-menu-icon]"));
    expect(icons.map((icon) => icon.getAttribute("data-me-menu-icon"))).toEqual([
      "profile",
      "security",
      "preferences",
      "help",
      "manual",
      "changelog",
      "report",
      "admin",
    ]);
    for (const icon of icons) {
      expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(icon.getAttribute("stroke-width")).toBe("1.7");
      expect(icon.getAttribute("stroke-linecap")).toBe("round");
      expect(icon.getAttribute("stroke-linejoin")).toBe("round");
    }

    const iconBoxes = icons.map((icon) => icon.parentElement?.textContent?.trim());
    expect(iconBoxes).toEqual(Array(8).fill(""));
  });

  it.each([319, 370])("%dpx 宽度下保留全部入口、提示和固定图标盒", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    navigation.pathname = "/production/pro1";
    act(() => root.render(
      <AppShell session={session} productions={productions}>
        <div>正文</div>
      </AppShell>,
    ));

    act(() => buttonWithText(mobileNav(), "我").click());

    const drawer = container.querySelector<HTMLElement>(".app-shell-bottom-drawer")!;
    expect(drawer).toBeTruthy();
    expect(drawer.querySelectorAll("svg[data-me-menu-icon]")).toHaveLength(8);
    expect(drawer.querySelectorAll(".h-\\[27px\\].w-\\[27px\\]")).toHaveLength(8);
    for (const hint of [
      "头像 · 姓名 · 简介",
      "登录方式 · 绑定身份",
      "通知 · 消息提醒",
      "查看当前页面的操作说明",
      "浏览全部功能说明",
      "查看最近的功能变化",
      "反馈异常或使用疑问",
      "专业档项目",
    ]) {
      expect(drawer.textContent).toContain(hint);
    }
  });

  it("桌面头像下拉仍保留原有入口与文字", () => {
    navigation.pathname = "/production/pro1";
    act(() => root.render(
      <AppShell
        session={session}
        productions={productions}
        helpRoutes={{ "": "start/interface/navigation" }}
        latestChangelogVersion="v0.1.1"
      >
        <div>正文</div>
      </AppShell>,
    ));

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="个人中心"]')!.click());

    const labels = ["个人信息", "账号安全中心", "功能与设置", "本页帮助", "使用手册", "更新日志", "报告问题", "配置中心"];
    for (const label of labels) {
      expect(container.textContent).toContain(label);
    }
    expect(container.querySelector("svg[data-me-menu-icon]")).toBeNull();
  });
});
