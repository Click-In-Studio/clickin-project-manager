// @vitest-environment jsdom
//
// 全量导航语义覆盖与接线：桌面、折叠、手机、权限可见性和在途状态。
import { act, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Production, ShellSession } from "@/components/shell/app-shell/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollTo = vi.fn();

const navigation = vi.hoisted(() => ({ pathname: "/", folded: false, pending: false }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending: navigation.pending }),
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
  useShellBadges: () => ({ unreadCount: 3, pendingTasks: 4, unreadReports: 5, cueWarnings: 2 }),
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
    productionSidebarContentFolded: navigation.folded,
    toggleScriptProductionSidebar: vi.fn(),
  }),
}));

import AppShell from "@/components/shell/AppShell";

import { renderToStaticMarkup } from "react-dom/server";
import { CREATION_NAV, PRODUCTION_NAV, PRODUCTION_OVERVIEW_NAV, ADMIN_NAV_GROUPS, OVERVIEW_NAV } from "@/components/shell/app-shell/nav-config";
import NavigationIcon from "@/components/shell/app-shell/NavigationIcon";
import MeMenuIcon from "@/components/shell/app-shell/MeMenuIcon";
import NavItem from "@/components/shell/app-shell/NavItem";

const session: ShellSession = { userId: "u1", name: "测试成员", avatarUrl: null };
const production: Production = {
  id: "pro1", name: "项目", archivedAt: null, roles: ["成员"], firstTag: null,
  canAdmin: true, canFinanceConfig: true, canManageApprovalFlows: true,
  avatarUrl: null, planAi: true, planAdvancedPerms: true,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  navigation.pathname = "/";
  navigation.folded = false;
  navigation.pending = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function renderShell(path: string, prod = production) {
  navigation.pathname = path;
  act(() => root.render(<AppShell session={session} productions={[prod]}><div>正文</div></AppShell>));
}
function iconName(link: Element) {
  return link.querySelector("svg")?.getAttribute("data-navigation-icon")
    ?? (link.querySelector('[data-me-menu-icon="profile"]') ? "person" : null);
}
function openDrawer(label: string) {
  const nav = container.querySelector(".app-shell-bottom-nav")!;
  act(() => Array.from(nav.querySelectorAll("button")).find(b => b.textContent === label)!.click());
  return container.querySelector(".app-shell-bottom-drawer-surface")!;
}
const projectItems = [...PRODUCTION_OVERVIEW_NAV, ...CREATION_NAV, ...PRODUCTION_NAV];
const adminItems = ADMIN_NAV_GROUPS.flatMap(g => g.items);

describe("统一导航图标", () => {
  it("每个模块都有线框图形，配置入口没有漏项或文字回退", () => {
    const items = [...projectItems, ...OVERVIEW_NAV, ...adminItems];
    for (const item of items) {
      act(() => root.render(<NavigationIcon name={item.icon} />));
      const svg = container.querySelector("svg")!;
      expect(svg).toBeTruthy();
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("stroke-width")).toBe("1.7");
      expect(svg.getAttribute("stroke-linecap")).toBe("round");
      expect(svg.getAttribute("stroke-linejoin")).toBe("round");
      expect(svg.textContent).toBe("");
      expect(svg.querySelector("path,rect,circle")).toBeTruthy();
    }
    expect(renderToStaticMarkup(<NavigationIcon name="person" />))
      .toBe(renderToStaticMarkup(<MeMenuIcon name="profile" />));
  });

  it.each([false, true])("项目侧栏 folded=%s 与三个手机抽屉使用相同语义图标", folded => {
    navigation.folded = folded;
    renderShell("/production/pro1/tasks");
    const links = Array.from(container.querySelectorAll("aside nav a"));
    expect(links.map(iconName)).toEqual(projectItems.map(i => i.icon));
    for (const [index, link] of links.entries()) {
      expect(link.getAttribute("href")).toBe(`/production/pro1${projectItems[index].path ? "/" + projectItems[index].path : ""}`);
      if (folded) expect(link.getAttribute("title")).toBe(projectItems[index].label);
    }
    for (const [label, items] of [["概览", PRODUCTION_OVERVIEW_NAV], ["创作", CREATION_NAV], ["制作", PRODUCTION_NAV]] as const) {
      const drawer = openDrawer(label);
      expect(Array.from(drawer.querySelectorAll("a")).map(iconName)).toEqual(items.map(i => i.icon));
      act(() => drawer.querySelector<HTMLAnchorElement>("a")!.click());
      expect(container.querySelector(".app-shell-bottom-drawer")).toBeNull();
    }
  });

  it.each([false, true])("配置侧栏 folded=%s 与手机菜单全量一致", folded => {
    navigation.folded = folded;
    renderShell("/production/pro1/admin");
    const links = Array.from(container.querySelectorAll("aside nav a"));
    expect(links.map(iconName)).toEqual(adminItems.map(i => i.icon));
    if (folded) expect(links.map(l => l.getAttribute("title"))).toEqual(adminItems.map(i => i.label));
    const drawer = openDrawer("配置菜单");
    expect(Array.from(drawer.querySelectorAll("a")).map(iconName)).toEqual(adminItems.map(i => i.icon));
  });

  it("平台侧栏和概览抽屉保持对应图标，底栏我仍是头像", () => {
    renderShell("/");
    expect(Array.from(container.querySelectorAll("aside nav a")).map(iconName))
      .toEqual(["home", "projects", "announcement", "calendar", "task", "notification", "report"]);
    const nav = container.querySelector(".app-shell-bottom-nav")!;
    expect(Array.from(nav.querySelectorAll("svg[data-navigation-icon]")).map(i => i.getAttribute("data-navigation-icon")))
      .toEqual(["home", "projects", "overview"]);
    const me = Array.from(nav.querySelectorAll("button")).find(b => b.textContent?.endsWith("我"))!;
    expect(me.querySelector("svg")).toBeNull();
    expect(me.textContent).toBe("测我");
    const drawer = openDrawer("概览");
    expect(Array.from(drawer.querySelectorAll("a")).map(iconName)).toEqual(OVERVIEW_NAV.map(i => i.icon));
  });

  it("档位与权限过滤保持原口径", () => {
    renderShell("/production/pro1/admin", { ...production, canAdmin: false, canManageApprovalFlows: false, planAdvancedPerms: false });
    expect(Array.from(container.querySelectorAll("aside nav a")).map(iconName)).toEqual(["finance"]);
    const drawer = openDrawer("配置菜单");
    expect(Array.from(drawer.querySelectorAll("a")).map(iconName)).toEqual(["finance"]);
  });

  it("图标替换不影响红色与警告角标、选中态或在途转圈", () => {
    renderShell("/production/pro1/tasks");
    const task = container.querySelector('aside a[href="/production/pro1/tasks"]')!;
    expect(task.textContent).toContain("4");
    expect(task.className).toContain("shadow-[inset_3px");
    expect(container.querySelector('aside a[href="/production/pro1/cues"]')!.textContent).toContain("2");
    act(() => root.render(<NavItem href="/task" symbol={<NavigationIcon name="task" />} label="任务" hint="跟进" active badge={4} warningBadge={2} folded />));
    expect(container.querySelector("a")!.getAttribute("aria-label")).toBe("任务 4");
    navigation.pending = true;
    act(() => root.render(<NavItem href="/task" symbol={<NavigationIcon name="task" />} label="任务" hint="跟进" active badge={4} folded />));
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
    expect(container.textContent).toBe("4");
  });
});
