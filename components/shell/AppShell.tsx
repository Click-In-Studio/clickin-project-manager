"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { userAvatarSrc } from "@/lib/asset/avatar-url";
import { nextNavPendingHref } from "@/lib/nav-pending";
import { AiTargetContext, nextAiTargetState, type AiTargetState, type ReportAiTarget } from "../agent/ai-target";
import SearchBar from "./SearchBar";
import PageActivationGate from "../perm/PageActivationGate";
import AgentPopout from "../agent/AgentPopout";
import {
  PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID,
  PRODUCTION_TOP_MENU_SEARCH_OVERFLOW_SLOT_ID,
  PRODUCTION_TOP_MENU_SLOT_ID,
  ProductionToolbarContext,
  ProductionToolbarStageContext,
} from "./ProductionTopMenu";
import type { Production, ShellSession } from "./app-shell/types";
import { CREATION_NAV, PRODUCTION_NAV, ADMIN_NAV_GROUPS, OVERVIEW_NAV, PRODUCTION_TOP_MENU_LABELS } from "./app-shell/nav-config";
import { firstContentChar } from "./app-shell/first-content-char";
import { extractProductionId, extractCurrentWikiId, extractCurrentAssetId, extractModule, extractAdminModule } from "./app-shell/route";
import { NavPendingContext, type NavPendingBus } from "./app-shell/nav-pending";
import UserAvatarContent from "./app-shell/UserAvatarContent";
import ProdAvatarIcon from "./app-shell/ProdAvatarIcon";
import NavItem from "./app-shell/NavItem";
import NavGroup from "./app-shell/NavGroup";
import DropdownItem from "./app-shell/DropdownItem";
import BottomDrawer from "./app-shell/BottomDrawer";
import MobileTab from "./app-shell/MobileTab";
import ProjectSwitcher from "./app-shell/ProjectSwitcher";
import { useShellBadges } from "./app-shell/use-shell-badges";
import { useProductionToolbarStage } from "./app-shell/use-production-toolbar-stage";
import { useSidebarFold } from "./app-shell/use-sidebar-fold";

interface AppShellProps {
  session: ShellSession | null;
  productions: Production[];
  /** 用户等级（付费维度）：无等级的普通注册用户菜单里不出现「新建项目」。 */
  canCreateProduction?: boolean;
  children: React.ReactNode;
  /** Server-rendered initial counts for sidebar badges. */
  initialUnreadCount?: number;
  initialPendingTasks?: number;
  initialUnreadReports?: number;
}

const SCROLLBAR_ACTIVITY_HIDE_DELAY_MS = 700;

type DrawerType = "overview" | "creation" | "production" | "admin" | "me";

export default function AppShell({ session, productions, canCreateProduction = false, children, initialUnreadCount = 0, initialPendingTasks = 0, initialUnreadReports = 0 }: AppShellProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // 页面显式上报的「当前对象」（#476 follow-up）——见 components/agent/ai-target.tsx
  const [aiTarget, setAiTarget] = useState<AiTargetState>(null);
  const reportAiTarget = useCallback<ReportAiTarget>((path, kind, id) => {
    setAiTarget((prev) => nextAiTargetState(prev, path, kind, id));
  }, []);
  const [aiPopoutOpen, setAiPopoutOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState<DrawerType | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { unreadCount, pendingTasks, unreadReports, cueWarnings } = useShellBadges({
    session, pathname, initialUnreadCount, initialPendingTasks, initialUnreadReports,
  });
  const {
    productionHeaderStage,
    productionToolbarStage,
    productionToolbarHasStoredControls,
    topbarRef,
    topOverflowRef,
    topOverflowOpen,
    setTopOverflowOpen,
    topOverflowMenu,
    productionSearchPath,
    handleProductionSearchOpenChange,
    productionToolbarContext,
  } = useProductionToolbarStage({ pathname });

  // 侧栏在途项（见 NavPendingContext）。归约规则连同连点竞态的说明
  // 见 lib/nav-pending.ts。
  const [navPendingHref, setNavPendingHref] = useState<string | null>(null);
  const reportNavPending = useCallback((href: string, pending: boolean) => {
    setNavPendingHref((prev) => nextNavPendingHref(prev, href, pending));
  }, []);
  const navPendingBus = useMemo<NavPendingBus>(
    () => ({ href: navPendingHref, report: reportNavPending }),
    [navPendingHref, reportNavPending],
  );
  // 导航落地即交还给 pathname 推导的 active。
  useEffect(() => { setNavPendingHref(null); }, [pathname]);






  useEffect(() => {
    const hideTimers = new Map<HTMLElement, number>();
    const scrollbarForArea = (area: HTMLElement) => area.matches(".panel-scrollbar")
      ? area
      : area.querySelector<HTMLElement>(".panel-scrollbar");
    const hideActiveScrollbar = (scrollbar: HTMLElement) => {
      const timer = hideTimers.get(scrollbar);
      if (timer !== undefined) window.clearTimeout(timer);
      hideTimers.delete(scrollbar);
      scrollbar.classList.remove("is-scroll-active");
    };
    const revealActiveScrollbar = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const scrollbar = target.closest<HTMLElement>(".panel-scrollbar");
      if (!scrollbar) return;

      scrollbar.classList.add("is-scroll-active");
      const previousTimer = hideTimers.get(scrollbar);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      hideTimers.set(scrollbar, window.setTimeout(() => {
        hideActiveScrollbar(scrollbar);
      }, SCROLLBAR_ACTIVITY_HIDE_DELAY_MS));
    };
    const hideScrollbarOnPanelExit = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const area = target.closest<HTMLElement>(".panel-scrollbar-area");
      const relatedTarget = event.relatedTarget;
      if (!area || (relatedTarget instanceof Node && area.contains(relatedTarget))) return;
      const scrollbar = scrollbarForArea(area);
      if (!scrollbar) return;
      hideActiveScrollbar(scrollbar);
    };

    document.addEventListener("scroll", revealActiveScrollbar, { passive: true, capture: true });
    document.addEventListener("pointerout", hideScrollbarOnPanelExit, true);
    return () => {
      document.removeEventListener("scroll", revealActiveScrollbar, { capture: true });
      document.removeEventListener("pointerout", hideScrollbarOnPanelExit, true);
      for (const scrollbar of hideTimers.keys()) hideActiveScrollbar(scrollbar);
    };
  }, []);



  useEffect(() => {
    setDrawerOpen(null);
    document.getElementById("workspace-scroll")?.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);



  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);


  const isScriptPage = /^\/production\/[^/]+\/script(?:\/|$)/.test(pathname);
  const {
    generalSidebarFolded,
    setGeneralSidebarFolded,
    productionSidebarOverlayOpen,
    productionSidebarFolded,
    productionSidebarContentFolded,
    toggleScriptProductionSidebar,
  } = useSidebarFold({ isScriptPage });


  // 打印路由不要 app shell：纸上不该有导航，无头浏览器也不该为一张 PDF
  // 加载整个侧栏。打印页挂在各资源自己的路径下（/production/x/script/print），
  // 所以按末段判定，不另起顶层前缀——那会让 extractProductionId 之类
  // 按 /production/<id>/ 解析上下文的地方全部失效。
  const isPrintRoute = pathname.endsWith("/print") || pathname.includes("/print/");
  if (!session || pathname.startsWith("/login") || isPrintRoute) {
    return <>{children}</>;
  }

  const isUnauthorizedPage = pathname.startsWith("/unauthorized");
  const productionId = extractProductionId(pathname) ?? (isUnauthorizedPage ? searchParams.get("id") : null);
  const activeModule = productionId && pathname.startsWith(`/production/${productionId}`)
    ? extractModule(pathname, productionId)
    : null;
  // 「附带当前对象」的主语：页面上报的优先（它查过树，知道 `nd_` 段是什么），
  // 没上报才回落 pathname 正则。上报带路由是防串台的凭据——换页那一瞬旧值仍在
  // state 里，路由对不上就当没有。
  const activeAiTarget = aiTarget && aiTarget.path === pathname ? aiTarget : null;
  const currentWikiId = activeAiTarget
    ? (activeAiTarget.kind === "wiki" ? activeAiTarget.id : null)
    : productionId ? extractCurrentWikiId(pathname, productionId) : null;
  const currentAssetId = activeAiTarget
    ? (activeAiTarget.kind === "asset" ? activeAiTarget.id : null)
    : productionId ? extractCurrentAssetId(pathname, productionId) : null;
  const hasProductionTopMenu = !!activeModule && ["script", "dramaturgy", "characters", "cues", "cuelists"].includes(activeModule);
  const isHome = pathname === "/";
  const currentProduction = productionId
    ? productions.find((p) => p.id === productionId)
    : null;
  const activeProductions = productions.filter((p) => !p.archivedAt);
  // AI 助手入口的显隐是项目档位（付费维度）。边界与后端门一致：只有 production 会话
  // 过 requireProductionFeature(id, "ai")，项目视图外是个人会话、不归项目档位管，
  // 所以那里照常显示。
  const aiEntryVisible = productionId ? (currentProduction?.planAi ?? false) : true;
  const isAdminMode = !!(productionId && pathname.startsWith(`/production/${productionId}/admin`));
  const activeAdminModule = isAdminMode ? extractAdminModule(pathname, productionId!) : null;
  // 管理后台菜单的档位过滤（付费维度）：档位没开「高级权限配置」的项目，权限中心 /
  // 策略中心根本不出现在菜单里。整组被滤空时连组标题一起去掉。
  // 不用 useMemo：这一段在 `if (!session)` 的 early return 之后，包 hook 就成了条件调用
  // （react-hooks/rules-of-hooks）。六组菜单过一遍 filter，每次渲染重算的代价可以忽略。
  const planAdvancedPerms = currentProduction?.planAdvancedPerms ?? false;
  const adminNavGroups = ADMIN_NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((it) => !it.feature || planAdvancedPerms) }))
    .filter((g) => g.items.length > 0);

  function navHref(path: string) {
    return productionId ? `/production/${productionId}/${path}` : "#";
  }

  function accountHref(tab: "profile" | "security" | "preferences") {
    const from = productionId ? `/production/${productionId}` : "/";
    return `/account?tab=${tab}&from=${encodeURIComponent(from)}`;
  }

  function adminHref(path: string) {
    if (!productionId) return "#";
    return path ? `/production/${productionId}/admin/${path}` : `/production/${productionId}/admin`;
  }

  function isModuleActive(path: string | readonly string[]) {
    if (!productionId || activeModule === null) return false;
    const paths = Array.isArray(path) ? path : [path];
    return (paths as string[]).includes(activeModule);
  }

  const isCreationItemActive = (path: (typeof CREATION_NAV)[number]["path"]) =>
    isModuleActive(
      path === "dramaturgy"
        ? ["dramaturgy", "characters"]
        : path === "cues"
          ? ["cues", "cuelists"]
          : path,
    );
  const isCreationActive = CREATION_NAV.some((item) => isCreationItemActive(item.path));
  const isProductionNavActive = PRODUCTION_NAV.some((item) => isModuleActive(item.path));
  const isOverviewActive = OVERVIEW_NAV.some((item) => pathname.startsWith(item.path));

  const closeDrawer = () => setDrawerOpen(null);
  const toggleDrawer = (type: DrawerType) =>
    setDrawerOpen((d) => (d === type ? null : type));

  const userInitial = firstContentChar(session.name);
  const avatarSrc = userAvatarSrc(session.userId, session.avatarUrl);
  const avatarSymbol = (
    <span className="relative">
      <UserAvatarContent src={avatarSrc} initial={userInitial} compact />
      {unreadCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#c0392b] border border-[var(--paper)]" />
      )}
    </span>
  );

  return (
    <ProductionToolbarStageContext.Provider value={productionToolbarStage}>
    <ProductionToolbarContext.Provider value={productionToolbarContext}>
    <NavPendingContext.Provider value={navPendingBus}>
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--paper)]">
      {/* Topbar */}
      <header ref={topbarRef} className="h-16 shrink-0 bg-[var(--surface)] border-b border-[var(--line)] flex items-center gap-5 px-5 z-50">
        {/* Brand / production icon */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-8 h-8 rounded-full bg-[#182a2a] overflow-hidden flex items-center justify-center select-none shrink-0">
            {productionId && currentProduction ? (
              currentProduction.avatarUrl ? (
                <ProdAvatarIcon productionId={productionId} avatarUrl={currentProduction.avatarUrl} name={currentProduction.name} />
              ) : (
                <span className="text-white text-[11px] font-bold select-none">{firstContentChar(currentProduction.name)}</span>
              )
            ) : (
              <span className="text-white text-[10px] font-bold select-none">BS</span>
            )}
          </span>
          <span className={`${productionHeaderStage >= 1 ? "hidden" : "block"} text-[13px] font-bold tracking-[0.12em] text-[#182a2a]`}>
            Backstage
          </span>
        </Link>

        {/* Project switcher */}
        <ProjectSwitcher
          activeProductions={activeProductions}
          currentProduction={currentProduction ?? null}
          currentProductionId={productionId}
          canCreateProduction={canCreateProduction}
          onOpen={() => setDropdownOpen(false)}
        />

        {isAdminMode && productionId && (
          <Link
            href={`/production/${productionId}`}
            className="inline-flex h-9 shrink-0 items-center rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 text-[11px] font-semibold text-[var(--stage)] transition-colors hover:border-[var(--stage)] hover:bg-[var(--paper)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stage)]/30"
          >
            <span aria-hidden="true" className="mr-1.5">←</span>
            返回项目
          </Link>
        )}

        {hasProductionTopMenu && (
          <div
            id={PRODUCTION_TOP_MENU_SLOT_ID}
            data-search-open={productionSearchPath === pathname ? "true" : undefined}
            className="flex h-full min-w-0 flex-1 items-center"
          >
            <div
              data-production-top-menu-placeholder
              aria-hidden="true"
              className="flex shrink-0 flex-col"
              style={{ lineHeight: 1.2 }}
            >
              <span className="max-w-40 truncate whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--script)]">
                {currentProduction?.name ?? ""}
              </span>
              <span className="text-xs font-semibold text-[var(--ink)]">
                {PRODUCTION_TOP_MENU_LABELS[activeModule ?? ""]}
              </span>
            </div>
          </div>
        )}

        {/* Right actions */}
        <div className={`${hasProductionTopMenu ? "-ml-2" : "ml-auto"} flex shrink-0 items-center gap-3`}>
          {/* Search bar: only when inside a production */}
          <SearchBar
            key={pathname}
            productionId={productionId}
            onOpenChange={hasProductionTopMenu ? handleProductionSearchOpenChange : undefined}
          />

          {/* AI 助手：右侧浮动 popout 开关（原通知铃铛已迁至侧栏"通知提醒"，此处让位）。
              免费档项目里整个入口不出现——见 aiEntryVisible。 */}
          {aiEntryVisible && (
          <button
            type="button"
            data-ai-toggle
            onClick={() => setAiPopoutOpen((v) => !v)}
            aria-label="AI 助手"
            aria-expanded={aiPopoutOpen}
            className={`relative ${productionHeaderStage >= 2 ? "hidden" : "hidden lg:flex"} w-9 h-9 rounded-full border ${aiPopoutOpen ? "border-[var(--ink)]" : "border-[var(--line)]"} bg-[var(--surface)] items-center justify-center text-[#667676] hover:bg-[var(--paper)] transition-colors text-[10px] font-bold tracking-tight shrink-0`}
            title="AI 助手"
          >
            AI
          </button>
          )}

          {/* User avatar + dropdown: sm+ only */}
          <div className={`relative shrink-0 ${productionHeaderStage >= 2 ? "hidden" : "block"}`} ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              aria-label="个人中心"
              aria-expanded={dropdownOpen}
              className="relative w-9 h-9 rounded-full border border-[var(--line)] overflow-hidden bg-[#182a2a] flex items-center justify-center hover:opacity-90 transition-opacity shrink-0"
            >
              <UserAvatarContent src={avatarSrc} initial={userInitial} />
              {unreadCount > 0 && (
                <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-[#c0392b] border-2 border-[var(--surface)]" />
              )}
            </button>

            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-2.5 w-[240px] bg-[var(--surface)] border border-[var(--line)] rounded-[13px] shadow-[0_18px_55px_rgba(24,42,42,.18)] z-50 overflow-hidden p-2">
                {/* ── 用户概要 ── */}
                <div className="flex items-center gap-2.5 px-2 py-2 mb-1 border-b border-[var(--line)]">
                  <span className="w-9 h-9 rounded-full bg-[#182a2a] overflow-hidden shrink-0 flex items-center justify-center">
                    <UserAvatarContent src={avatarSrc} initial={userInitial} />
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-bold text-[#182a2a] truncate">{session.name}</span>
                  </div>
                </div>

                {/* ── 账户 ── */}
                <DropdownItem href={accountHref("profile")} onClick={() => setDropdownOpen(false)}>个人信息</DropdownItem>
                <DropdownItem href={accountHref("security")} onClick={() => setDropdownOpen(false)}>账号安全中心</DropdownItem>

                {/* ── 偏好 ── */}
                <div className="h-px bg-[var(--line)] mx-1 my-1.5" />
                <DropdownItem href={accountHref("preferences")} onClick={() => setDropdownOpen(false)}>功能与设置</DropdownItem>

                {/* ── 配置中心 ── */}
                {currentProduction?.canAdmin && productionId && (
                  <>
                    <div className="h-px bg-[var(--line)] mx-1 my-1.5" />
                    <DropdownItem href={`/production/${productionId}/admin`} onClick={() => setDropdownOpen(false)}>
                      配置中心
                      <span className="ml-auto text-[10px] text-[#667676] truncate max-w-[90px]">{currentProduction.name}</span>
                    </DropdownItem>
                  </>
                )}

                {/* ── 退出 ── */}
                <div className="h-px bg-[var(--line)] mx-1 mt-1.5 mb-1" />
                <form action={`${BASE_PATH}/api/auth/logout`} method="post">
                  <button
                    type="submit"
                    className="w-full text-left flex items-center px-2.5 py-2 rounded-[7px] text-[11px] text-[#c0392b] hover:bg-[var(--paper)] transition-colors"
                  >
                    退出登录
                  </button>
                </form>
              </div>
            )}
          </div>

          {hasProductionTopMenu && (
            <div
              ref={topOverflowRef}
              id="production-top-toolbar-overflow"
              data-search-open={productionSearchPath === pathname ? "true" : undefined}
              className="relative shrink-0"
            >
              {productionToolbarHasStoredControls && (
                <button
                  ref={topOverflowMenu.anchorRef}
                  type="button"
                  aria-label="更多工具"
                  aria-expanded={topOverflowOpen}
                  onClick={() => setTopOverflowOpen((open) => !open)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border-0 bg-[var(--surface)] text-base font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
                >
                  ⋮
                </button>
              )}
              <div
                ref={topOverflowMenu.menuRef}
                style={topOverflowMenu.style}
                data-production-overflow-menu="true"
                className={productionToolbarHasStoredControls && topOverflowOpen
                  ? "z-40 flex w-52 flex-col rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md"
                  : "hidden"
                }
              >
                <div id={PRODUCTION_TOP_MENU_SEARCH_OVERFLOW_SLOT_ID} className="order-first shrink-0" />
                <div id={PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID} className="order-last shrink-0" />
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Body: sidebar + workspace */}
      <div className="relative flex flex-1 min-h-0">
        {/* Sidebar (desktop only) */}
        <aside
          className={`panel-scrollbar-area panel-scrollbar hidden lg:flex shrink-0 flex-col overflow-x-hidden overflow-y-auto bg-[#e8e8e1] border-r border-[var(--line)] transition-[width,padding,margin] duration-150 ${
            isScriptPage
              ? productionSidebarOverlayOpen
                ? "z-30 -mr-[168px] w-[240px] px-3.5 py-5 shadow-lg"
                : productionSidebarFolded
                ? "w-[72px] px-2 py-5"
                : "w-[240px] px-3.5 py-5"
              : generalSidebarFolded
              ? "w-[72px] px-2 py-5"
              : "w-[240px] px-3.5 py-5"
          }`}
        >
          {/* v3 sidebarControls：导航标签 + 全局折叠 toggle（原型样式） */}
          <div className={`mb-2 flex min-h-[30px] items-center text-[9px] font-bold uppercase tracking-[0.12em] text-[#667676] ${
            productionSidebarContentFolded ? "justify-center px-0" : "justify-between pl-2.5 pr-0.5"
          }`}>
            {!productionSidebarContentFolded && <span>导航</span>}
            <button
              type="button"
              onClick={() => (isScriptPage ? toggleScriptProductionSidebar() : setGeneralSidebarFolded(f => !f))}
              aria-label={productionSidebarFolded ? "展开左侧边栏" : "折叠左侧边栏"}
              aria-expanded={!productionSidebarFolded}
              title={productionSidebarFolded ? "展开左侧边栏" : "折叠左侧边栏"}
              className="grid h-[30px] w-[30px] place-items-center rounded-[8px] text-[#667676] transition-colors hover:bg-white/60 hover:text-[var(--ink)]"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true" className={`h-[18px] w-[18px] fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.5] ${productionSidebarFolded ? "-scale-x-100" : ""}`}>
                <rect x="2.5" y="3" width="15" height="14" rx="2" />
                <path d="M7 3v14M12.5 7.5 10 10l2.5 2.5" />
              </svg>
            </button>
          </div>
          {isAdminMode ? (
            /* ── Admin sidebar ── */
            <nav className="flex flex-col gap-0.5 flex-1">
              <div className="px-2.5 pt-1 pb-4">
                <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-[var(--stage)]">配置中心</p>
                <p className="text-[11px] text-[#667676] mt-0.5 truncate">{currentProduction?.name}</p>
              </div>

              {adminNavGroups.map((group, gi) => (
                <div key={gi} className="flex flex-col gap-0.5">
                  {group.title ? (
                    <p className="px-2.5 pt-3 pb-1 text-[9px] font-bold tracking-[0.14em] uppercase text-[#667676]">{group.title}</p>
                  ) : gi > 0 ? (
                    <div className="mx-2.5 my-2 border-t border-[var(--line)]" />
                  ) : null}
                  {group.items.map((item) => (
                    <NavItem
                      key={item.path}
                      href={adminHref(item.path)}
                      symbol={item.label.charAt(0)}
                      label={item.label}
                      hint={item.hint}
                      active={activeAdminModule === item.path}
                    />
                  ))}
                </div>
              ))}
            </nav>
          ) : (
            /* ── Regular sidebar ── */
            <nav className="flex flex-col gap-0.5 flex-1">
              {!productionId && (
                <div className="mt-1 flex flex-col gap-0.5">
                  <NavItem href="/" symbol="⌂" label="我的工作" hint="今天与我有关" active={isHome} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/projects" symbol="◈" label="我的项目" hint={canCreateProduction ? "管理与新建项目" : "我参与的项目"} active={pathname.startsWith("/my/projects")} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/announcements" symbol="⊟" label="公告" hint="演出公告与风险提醒" active={pathname.startsWith("/my/announcements")} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/weekly-call" symbol="◷" label="日程" hint="完整 Weekly Call" active={pathname.startsWith("/my/weekly-call") || pathname.startsWith("/my/daily-call")} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/tasks" symbol="✓" label="任务" hint="需求 · 跟进 · 完成" active={pathname.startsWith("/my/tasks")} badge={pendingTasks} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/notifications" symbol="◉" label="通知提醒" hint="确认与告知" active={pathname.startsWith("/my/notifications")} badge={unreadCount} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/reports" symbol="≡" label="报告" hint="所有演出报告" active={pathname.startsWith("/my/reports")} badge={unreadReports} folded={productionSidebarContentFolded} />
                </div>
              )}

              {productionId ? (
                <>
                  <NavGroup label="项目总览" color="overview" folded={productionSidebarContentFolded} first />
                  <NavItem href={`/production/${productionId}`} symbol="⌂" label="我的工作" hint="今天与我有关" active={activeModule === ""} folded={productionSidebarContentFolded} />
                  <NavItem
                    href={navHref("notifications")}
                    symbol="◉"
                    label="我的通知"
                    hint="项目公告 · 个人通知"
                    active={isModuleActive("notifications") || isModuleActive("announcements")}
                    badge={unreadCount}
                    folded={productionSidebarContentFolded}
                  />
                  <NavItem href={navHref("access-requests")} symbol="◑" label="资源申请" hint="权限申请 · 待审批" active={isModuleActive("access-requests")} folded={productionSidebarContentFolded} />

                  <NavGroup label="创作侧" color="script" folded={productionSidebarContentFolded} />
                  {CREATION_NAV.map((item) => (
                    <NavItem
                      key={item.path}
                      href={navHref(item.path)}
                      symbol={item.symbol}
                      label={item.label}
                      hint={item.hint}
                      side="script"
                      active={isCreationItemActive(item.path)}
                      warningBadge={item.path === "cues" ? cueWarnings : undefined}
                      folded={productionSidebarContentFolded}
                    />
                  ))}

                  <NavGroup label="制作侧" color="stage" folded={productionSidebarContentFolded} />
                  {PRODUCTION_NAV.map((item) => (
                    <NavItem
                      key={item.path}
                      href={navHref(item.path)}
                      symbol={item.symbol}
                      label={item.label}
                      hint={item.hint}
                      side="stage"
                      active={isModuleActive(item.path)}
                      badge={
                        item.path === "tasks" ? pendingTasks :
                        item.path === "reports" ? unreadReports :
                        undefined
                      }
                      folded={productionSidebarContentFolded}
                    />
                  ))}
                </>
              ) : null}
            </nav>
          )}
        </aside>

        {/* 剧本页原浮动折叠按钮已移除——统一走侧栏顶部 sidebarControls（v3） */}

        {/* Workspace */}
        <main id="workspace-scroll" className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <AiTargetContext.Provider value={reportAiTarget}>{children}</AiTargetContext.Provider>
        </main>
      </div>

      {/* Level 1: base view-grant activation — resets on production switch */}
      {productionId && <PageActivationGate key={productionId} productionId={productionId} scope="base" />}

      {/* Mobile bottom nav */}
      <nav className="lg:hidden shrink-0 bg-[var(--surface)] border-t border-[var(--line)] flex z-40 safe-area-bottom">
        {productionId ? (
          isAdminMode ? (
            /* Admin mode */
            <>
              <MobileTab
                label="返回"
                symbol="←"
                active={false}
                href={`/production/${productionId}`}
              />
              <MobileTab
                label="配置菜单"
                symbol="⚙"
                active={drawerOpen === "admin"}
                onClick={() => toggleDrawer("admin")}
              />
              <div className="flex-1" />
              <MobileTab
                label="我"
                symbol={avatarSymbol}
                active={drawerOpen === "me"}
                onClick={() => toggleDrawer("me")}
              />
            </>
          ) : (
            /* Production mode */
            <>
              <MobileTab
                label="今日"
                symbol="⌂"
                active={activeModule === ""}
                href={`/production/${productionId}`}
              />
              <MobileTab
                label="创作"
                symbol="✦"
                active={isCreationActive || drawerOpen === "creation"}
                onClick={() => toggleDrawer("creation")}
              />
              <MobileTab
                label="制作"
                symbol="◇"
                active={isProductionNavActive || drawerOpen === "production"}
                onClick={() => toggleDrawer("production")}
              />
              <MobileTab
                label="我"
                symbol={avatarSymbol}
                active={drawerOpen === "me"}
                onClick={() => toggleDrawer("me")}
              />
            </>
          )
        ) : (
          /* Outside production */
          <>
            <MobileTab label="今日" symbol="⌂" active={isHome} href="/" />
            <MobileTab
              label="项目"
              symbol="◈"
              active={pathname.startsWith("/my/projects")}
              href="/my/projects"
            />
            <MobileTab
              label="概览"
              symbol="≡"
              active={isOverviewActive || drawerOpen === "overview"}
              onClick={() => toggleDrawer("overview")}
            />
            <MobileTab
              label="我"
              symbol={avatarSymbol}
              active={drawerOpen === "me"}
              onClick={() => toggleDrawer("me")}
            />
          </>
        )}
      </nav>

      {/* ── Bottom Drawers ── */}

      {/* 概览 drawer (outside production) */}
      <BottomDrawer open={drawerOpen === "overview"} onClose={closeDrawer}>
        <div className="px-3.5 pb-4">
          <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-[#667676] px-2.5 pt-1 pb-2">
            概览
          </p>
          {OVERVIEW_NAV.map((item) => (
            <NavItem
              key={item.path}
              href={item.path}
              symbol={item.symbol}
              label={item.label}
              hint={item.hint}
              active={pathname.startsWith(item.path)}
              onClick={closeDrawer}
            />
          ))}
        </div>
      </BottomDrawer>

      {/* 创作 drawer */}
      <BottomDrawer open={drawerOpen === "creation"} onClose={closeDrawer}>
        <div className="px-3.5 pb-4">
          <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2">
            <span className="w-[7px] h-[7px] rounded-full bg-[#2f6670] shrink-0" />
            <span className="text-[10px] font-bold tracking-[0.12em] uppercase text-[#667676]">创作侧</span>
          </div>
          {CREATION_NAV.map((item) => (
            <NavItem
              key={item.path}
              href={navHref(item.path)}
              symbol={item.symbol}
              label={item.label}
              hint={item.hint}
              active={isCreationItemActive(item.path)}
              onClick={closeDrawer}
            />
          ))}
        </div>
      </BottomDrawer>

      {/* 制作 drawer */}
      <BottomDrawer open={drawerOpen === "production"} onClose={closeDrawer}>
        <div className="px-3.5 pb-4">
          <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2">
            <span className="w-[7px] h-[7px] rounded-full bg-[#a55c32] shrink-0" />
            <span className="text-[10px] font-bold tracking-[0.12em] uppercase text-[#667676]">制作侧</span>
          </div>
          {PRODUCTION_NAV.map((item) => (
            <NavItem
              key={item.path}
              href={navHref(item.path)}
              symbol={item.symbol}
              label={item.label}
              hint={item.hint}
              active={isModuleActive(item.path)}
              onClick={closeDrawer}
            />
          ))}
        </div>
      </BottomDrawer>

      {/* 管理菜单 drawer (admin mode mobile) */}
      <BottomDrawer open={drawerOpen === "admin"} onClose={closeDrawer}>
        <div className="px-3.5 pb-4">
          <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-[var(--stage)] px-2.5 pt-1 pb-2">
            配置中心
          </p>
          {adminNavGroups.map((group, gi) => (
            <div key={gi} className="flex flex-col gap-0.5">
              {group.title ? (
                <p className="px-2.5 pt-3 pb-1 text-[9px] font-bold tracking-[0.14em] uppercase text-[#667676]">{group.title}</p>
              ) : gi > 0 ? (
                <div className="mx-2.5 my-2 border-t border-[var(--line)]" />
              ) : null}
              {group.items.map((item) => (
                <NavItem
                  key={item.path}
                  href={adminHref(item.path)}
                  symbol={item.label.charAt(0)}
                  label={item.label}
                  hint={item.hint}
                  active={activeAdminModule === item.path}
                  onClick={closeDrawer}
                />
              ))}
            </div>
          ))}
        </div>
      </BottomDrawer>

      {/* 我 drawer */}
      <BottomDrawer open={drawerOpen === "me"} onClose={closeDrawer}>
        <div className="pb-4">
          {/* 用户概要 */}
          <div className="flex items-center gap-3 px-5 pt-1 pb-3">
            <span className="w-10 h-10 rounded-full bg-[#182a2a] overflow-hidden shrink-0 flex items-center justify-center">
              <UserAvatarContent src={avatarSrc} initial={userInitial} />
            </span>
            <span className="text-[14px] font-bold text-[#182a2a]">{session.name}</span>
          </div>
          <div className="mx-5 border-t border-[var(--line)]" />

          {/* 账户 */}
          <div className="px-3.5 pt-1 flex flex-col gap-0.5">
            <NavItem
              href={accountHref("profile")}
              symbol="人"
              label="个人信息"
              hint="头像 · 姓名 · 简介"
              active={pathname === "/account" && searchParams.get("tab") !== "security" && searchParams.get("tab") !== "preferences"}
              onClick={closeDrawer}
            />
            <NavItem
              href={accountHref("security")}
              symbol="盾"
              label="账号安全中心"
              hint="登录方式 · 绑定身份"
              active={pathname === "/account" && searchParams.get("tab") === "security"}
              onClick={closeDrawer}
            />
          </div>

          {/* 偏好 */}
          <div className="mx-5 my-1.5 border-t border-[var(--line)]" />
          <div className="px-3.5 flex flex-col gap-0.5">
            <NavItem
              href={accountHref("preferences")}
              symbol="调"
              label="功能与设置"
              hint="通知 · 消息提醒"
              active={pathname === "/account" && searchParams.get("tab") === "preferences"}
              onClick={closeDrawer}
            />
          </div>

          {/* 配置中心 */}
          {currentProduction?.canAdmin && productionId && (
            <>
              <div className="mx-5 my-1.5 border-t border-[var(--line)]" />
              <div className="px-3.5 flex flex-col gap-0.5">
                <NavItem
                  href={`/production/${productionId}/admin`}
                  symbol="⚙"
                  label="配置中心"
                  hint={currentProduction.name}
                  active={isAdminMode}
                  onClick={closeDrawer}
                />
              </div>
            </>
          )}

          {/* 退出 */}
          <div className="mx-5 my-2 border-t border-[var(--line)]" />
          <div className="px-5">
            <form action={`${BASE_PATH}/api/auth/logout`} method="post">
              <button
                type="submit"
                className="w-full text-left flex items-center gap-2 py-2.5 text-sm text-[#c0392b]"
              >
                退出登录
              </button>
            </form>
          </div>
        </div>
      </BottomDrawer>

      {/* AI 助手浮动 popout（对应左侧剧本页折叠导航的浮出样式，宽得多）——
          项目视图外只看得到个人会话，项目视图内只看得到该项目会话，范围
          由 productionId 决定。始终挂载，靠 CSS 隐藏，收起后台流不中断——
          但免费档项目里连挂都不挂（入口都没有，挂着只会白拉一次会话列表）。 */}
      {aiEntryVisible && (
      <AgentPopout
        open={aiPopoutOpen}
        onClose={() => setAiPopoutOpen(false)}
        onRequestOpen={() => setAiPopoutOpen(true)}
        productionId={productionId}
        productionName={currentProduction?.name ?? null}
        currentWikiId={currentWikiId}
        currentAssetId={currentAssetId}
      />
      )}
    </div>
    </NavPendingContext.Provider>
    </ProductionToolbarContext.Provider>
    </ProductionToolbarStageContext.Provider>
  );
}
