"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";

type Production = { id: string; name: string; archivedAt: string | null; roles: string[]; canAdmin: boolean };
type ShellSession = { name: string; avatarUrl: string | null };

interface AppShellProps {
  session: ShellSession | null;
  productions: Production[];
  children: React.ReactNode;
  /** Server-rendered initial counts for sidebar badges. */
  initialUnreadCount?: number;
  initialPendingTasks?: number;
  initialUnreadReports?: number;
}

const CREATION_NAV = [
  { label: "剧本", hint: "阅读 · 编辑 · 讨论", path: "script" },
  { label: "构作", hint: "章节 · 行动线", path: "dramaturgy" },
  { label: "角色", hint: "角色 · 人物关系 · 聚合", path: "characters" },
  { label: "Cue", hint: "部门执行设计", path: "cues" },
] as const;

const PRODUCTION_NAV = [
  { label: "人员", hint: "演员 · 部门 · 团队", path: "contacts" },
  { label: "日程", hint: "围读 · 排练 · 演出", path: "events" },
  { label: "任务", hint: "技术需求 · 跟进", path: "tasks" },
  { label: "报告", hint: "演出报告 · 归档", path: "reports" },
  { label: "通知", hint: "告知 · 确认 · 处理", path: "notifications" },
  { label: "财务", hint: "预算 · 支出 · 关联", path: "finance" },
  { label: "物料", hint: "道具 · 服装 · 设备", path: "materials" },
  { label: "数字资产", hint: "文件 · 图纸 · 音视频", path: "assets" },
] as const;

const ADMIN_NAV_GROUPS = [
  {
    items: [
      { label: "部门管理", hint: "部门 · 用户组", path: "departments" },
      { label: "角色管理", hint: "职称 · 权限配置", path: "roles" },
      { label: "人事权限", hint: "成员 · 个人授权", path: "permissions" },
    ],
  },
  {
    items: [
      { label: "项目管理", hint: "基本信息 · 集成", path: "settings" },
      { label: "通知公告", hint: "公告 · 群消息", path: "announcements" },
    ],
  },
] as const;

const OVERVIEW_NAV = [
  { label: "公告", hint: "演出公告与风险提醒", path: "/my/announcements", symbol: "⊟" },
  { label: "日程", hint: "完整 Weekly Call", path: "/my/weekly-call", symbol: "◷" },
  { label: "任务", hint: "需求 · 跟进 · 完成", path: "/my/tasks", symbol: "✓" },
  { label: "通知提醒", hint: "确认与告知", path: "/my/notifications", symbol: "◉" },
  { label: "报告", hint: "所有演出报告", path: "/my/reports", symbol: "≡" },
] as const;

function extractProductionId(pathname: string): string | null {
  const m = pathname.match(/^\/production\/([^/]+)/);
  return m ? m[1] : null;
}

function extractModule(pathname: string, productionId: string): string {
  const base = `/production/${productionId}`;
  if (pathname === base || pathname === base + "/") return "";
  const rest = pathname.slice(base.length + 1);
  const first = rest.split("/")[0];
  if (first === "events") {
    if (rest.includes("/reqs/")) return "tasks";
    if (rest.includes("/reports/")) return "reports";
  }
  return first;
}

function extractAdminModule(pathname: string, productionId: string): string {
  const base = `/production/${productionId}/admin`;
  if (pathname === base || pathname === base + "/") return "";
  const rest = pathname.slice(base.length + 1);
  return rest.split("/")[0];
}

function NavItem({
  href,
  symbol,
  label,
  hint,
  active,
  badge,
  onClick,
}: {
  href: string;
  symbol: string;
  label: string;
  hint: string;
  active: boolean;
  badge?: number;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 min-h-[46px] transition-colors ${
        active
          ? "bg-[var(--surface)] shadow-[inset_3px_0_0_#182a2a]"
          : "hover:bg-white/50"
      }`}
    >
      <span className="w-[27px] h-[27px] rounded-[7px] border border-[#cbd2cf] flex items-center justify-center text-[11px] text-[#667676] shrink-0 leading-none">
        {symbol}
      </span>
      <span className="flex flex-col min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[12px] font-bold text-[#182a2a] leading-tight">{label}</span>
          {badge != null && badge > 0 && (
            <span className="min-w-[16px] h-4 px-1 rounded-full bg-[#c0392b] text-white text-[9px] font-bold flex items-center justify-center leading-none shrink-0">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </span>
        <span className="text-[9px] text-[#667676] mt-0.5 truncate">{hint}</span>
      </span>
    </Link>
  );
}

function NavGroup({ label, color }: { label: string; color: "script" | "stage" }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-5 pb-1.5">
      <span
        className={`w-[7px] h-[7px] rounded-full shrink-0 ${
          color === "script" ? "bg-[#2f6670]" : "bg-[#a55c32]"
        }`}
      />
      <span className="text-[10px] font-bold tracking-[0.12em] uppercase text-[#667676]">
        {label}
      </span>
    </div>
  );
}

type DrawerType = "overview" | "creation" | "production" | "admin" | "me";

function BottomDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-[#e8e8e1] rounded-t-2xl max-h-[75vh] overflow-y-auto">
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-8 h-1 bg-[#b0b8b4] rounded-full" />
        </div>
        {children}
      </div>
    </div>
  );
}

function MobileTab({
  label,
  symbol,
  active,
  href,
  onClick,
}: {
  label: string;
  symbol: React.ReactNode;
  active: boolean;
  href?: string;
  onClick?: () => void;
}) {
  const cls = `flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-medium transition-colors ${
    active ? "text-[#182a2a]" : "text-[#667676]"
  }`;
  const inner = (
    <>
      <span className="h-[18px] flex items-center justify-center leading-none text-base">
        {symbol}
      </span>
      {label}
    </>
  );
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  return <button onClick={onClick} className={cls}>{inner}</button>;
}

export default function AppShell({ session, productions, children, initialUnreadCount = 0, initialPendingTasks = 0, initialUnreadReports = 0 }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState<DrawerType | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [pendingTasks, setPendingTasks] = useState(initialPendingTasks);
  const [unreadReports, setUnreadReports] = useState(initialUnreadReports);

  // Track current productionId via ref so fetchCounts always uses the latest value
  // without needing to be in the effect dependency array.
  const currentProductionIdRef = useRef<string | null>(extractProductionId(pathname));
  currentProductionIdRef.current = extractProductionId(pathname);

  // Expose fetchCounts via ref so the production-switch effect can call it.
  const fetchCountsRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setDrawerOpen(null);
    document.getElementById("workspace-scroll")?.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);

  // When the user switches to a different production, clear badges immediately so
  // stale counts from the previous context don't briefly show.
  const prevProductionIdRef = useRef<string | null>(currentProductionIdRef.current);
  useEffect(() => {
    const pid = extractProductionId(pathname);
    if (pid !== prevProductionIdRef.current) {
      prevProductionIdRef.current = pid;
      if (session) {
        setUnreadCount(0);
        setPendingTasks(0);
        setUnreadReports(0);
        fetchCountsRef.current?.();
      }
    }
  }, [pathname, session]);

  // Keep badge fresh:
  // 1. Re-fetch when tab becomes visible (like GitHub) or window regains focus.
  // 2. Listen for custom 'notif-read' events dispatched by the notifications page
  //    so the badge decrements instantly without waiting for the next poll.
  // 3. 60 s poll as a backstop for long-lived focused tabs.
  useEffect(() => {
    if (!session) return;

    const fetchCounts = () => {
      const pid = currentProductionIdRef.current;
      const url = pid
        ? `/api/my/pending-counts?productionId=${encodeURIComponent(pid)}`
        : "/api/my/pending-counts";
      return fetch(url)
        .then((r) => r.json())
        .then((d: { notifications?: number; tasks?: number; reports?: number }) => {
          if (typeof d.notifications === "number") setUnreadCount(d.notifications);
          if (typeof d.tasks === "number") setPendingTasks(d.tasks);
          if (typeof d.reports === "number") setUnreadReports(d.reports);
        })
        .catch(() => {});
    };

    fetchCountsRef.current = fetchCounts;

    const onVisible = () => { if (!document.hidden) fetchCounts(); };
    const onRead = (e: Event) => {
      const delta = (e as CustomEvent<{ delta?: number }>).detail?.delta;
      if (typeof delta === "number") {
        setUnreadCount((c) => Math.max(0, c - delta));
      } else {
        fetchCounts();
      }
    };

    fetchCounts();
    const id = setInterval(fetchCounts, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("notif-read", onRead);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("notif-read", onRead);
    };
  }, [session]);

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

  if (!session || pathname.startsWith("/login")) {
    return <>{children}</>;
  }

  const isUnauthorizedPage = pathname.startsWith("/unauthorized");
  const productionId = extractProductionId(pathname) ?? (isUnauthorizedPage ? searchParams.get("id") : null);
  const activeModule = productionId && pathname.startsWith(`/production/${productionId}`)
    ? extractModule(pathname, productionId)
    : null;
  const isHome = pathname === "/";
  const currentProduction = productionId
    ? productions.find((p) => p.id === productionId)
    : null;
  const activeProductions = productions.filter((p) => !p.archivedAt);
  const isAdminMode = !!(productionId && pathname.startsWith(`/production/${productionId}/admin`));
  const activeAdminModule = isAdminMode ? extractAdminModule(pathname, productionId!) : null;

  function navHref(path: string) {
    return productionId ? `/production/${productionId}/${path}` : "#";
  }

  function adminHref(path: string) {
    return productionId ? `/production/${productionId}/admin/${path}` : "#";
  }

  function isModuleActive(path: string | readonly string[]) {
    if (!productionId || activeModule === null) return false;
    const paths = Array.isArray(path) ? path : [path];
    return (paths as string[]).includes(activeModule);
  }

  const isCreationActive = CREATION_NAV.some((item) =>
    isModuleActive(item.path === "cues" ? ["cues", "cuelists"] : item.path)
  );
  const isProductionNavActive = PRODUCTION_NAV.some((item) => isModuleActive(item.path));
  const isOverviewActive = OVERVIEW_NAV.some((item) => pathname.startsWith(item.path));

  const closeDrawer = () => setDrawerOpen(null);
  const toggleDrawer = (type: DrawerType) =>
    setDrawerOpen((d) => (d === type ? null : type));

  const userInitial = session.name.charAt(0);
  const avatarSymbol = (
    <span className="relative">
      <span className="w-5 h-5 rounded-full bg-[#182a2a] text-white text-[9px] font-bold flex items-center justify-center">
        {userInitial}
      </span>
      {unreadCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#c0392b] border border-[var(--paper)]" />
      )}
    </span>
  );

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--paper)]">
      {/* Topbar */}
      <header className="h-16 shrink-0 bg-[var(--surface)] border-b border-[var(--line)] flex items-center gap-5 px-5 z-40">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-8 h-8 rounded-full bg-[#182a2a] text-white text-[10px] font-bold flex items-center justify-center select-none">
            BS
          </span>
          <span className="text-[13px] font-bold tracking-[0.12em] text-[#182a2a] hidden md:block">
            Backstage
          </span>
        </Link>

        {/* Context controls */}
        <div className="flex items-center gap-2.5 min-w-0">
          <label className="flex items-center gap-2 text-[10px] text-[#667676] uppercase tracking-[0.08em]">
            <span className="hidden lg:block shrink-0">机构 / 项目</span>
            <select
              value={productionId ?? ""}
              onChange={(e) => {
                if (e.target.value) router.push(`/production/${e.target.value}`);
                else router.push("/");
              }}
              className="border border-[var(--line)] bg-[var(--paper)] rounded-lg py-2 pl-2.5 pr-7 text-[#182a2a] text-[12px] cursor-pointer outline-none focus:border-[#182a2a] max-w-[150px] sm:max-w-[180px] lg:max-w-[240px]"
            >
              <option value="">— 选择项目 —</option>
              {activeProductions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          {/* Role badge: desktop only */}
          {productionId && currentProduction && currentProduction.roles.length > 0 && (
            <div className="hidden lg:flex items-center gap-2 text-[10px] text-[#667676] uppercase tracking-[0.08em]">
              <span className="shrink-0">我的角色</span>
              <span className="border border-[var(--line)] bg-[var(--paper)] rounded-lg py-2 px-2.5 text-[#182a2a] text-[12px]">
                {currentProduction.roles.join(" · ")}
              </span>
            </div>
          )}
        </div>

        {/* Right actions */}
        <div className="ml-auto flex items-center gap-3">
          {/* Notification bell: sm+ only */}
          <Link
            href={productionId ? `/production/${productionId}/notifications` : "/my/notifications"}
            className="relative hidden sm:flex w-9 h-9 rounded-full border border-[var(--line)] bg-[var(--surface)] items-center justify-center text-[#667676] hover:bg-[var(--paper)] transition-colors text-sm shrink-0"
            title="通知"
            onClick={() => setUnreadCount(0)}
          >
            ◉
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 rounded-full bg-[#c0392b] text-white text-[9px] font-bold flex items-center justify-center leading-none">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Link>

          {/* User dropdown: sm+ only */}
          <div className="relative hidden sm:block" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              className="flex items-center gap-1 text-sm text-[#667676] hover:text-[#182a2a] transition-colors"
            >
              {session.name}
              <span className="text-[10px] opacity-50 ml-0.5">{dropdownOpen ? "▲" : "▼"}</span>
            </button>

            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-44 bg-[var(--surface)] border border-[var(--line)] rounded-xl shadow-lg z-50 overflow-hidden py-1">
                {currentProduction?.canAdmin && productionId && (
                  <Link
                    href={`/production/${productionId}/admin`}
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center gap-2 px-4 py-2.5 text-sm text-[#182a2a] hover:bg-[var(--paper)] transition-colors"
                  >
                    <span className="text-[11px] opacity-40">⚙</span>
                    管理后台
                  </Link>
                )}
                <Link
                  href="/account?tab=profile"
                  onClick={() => setDropdownOpen(false)}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-[#182a2a] hover:bg-[var(--paper)] transition-colors"
                >
                  <span className="text-[11px] opacity-40">人</span>
                  个人信息
                </Link>
                <Link
                  href="/account?tab=security"
                  onClick={() => setDropdownOpen(false)}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-[#182a2a] hover:bg-[var(--paper)] transition-colors"
                >
                  <span className="text-[11px] opacity-40">盾</span>
                  账号安全中心
                </Link>
                <Link
                  href="/account?tab=preferences"
                  onClick={() => setDropdownOpen(false)}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-[#182a2a] hover:bg-[var(--paper)] transition-colors"
                >
                  <span className="text-[11px] opacity-40">调</span>
                  功能与设置
                </Link>
                <div className="h-px bg-[var(--line)] mx-3 my-1" />
                <form action={`${BASE_PATH}/api/auth/logout`} method="post">
                  <button
                    type="submit"
                    className="w-full text-left flex items-center gap-2 px-4 py-2.5 text-sm text-[#667676] hover:bg-[var(--paper)] transition-colors"
                  >
                    <span className="text-[11px] opacity-40">→</span>
                    退出
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Body: sidebar + workspace */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar (desktop only) */}
        <aside className="hidden lg:flex w-[240px] shrink-0 flex-col overflow-y-auto bg-[#e8e8e1] border-r border-[var(--line)] px-3.5 py-5">
          {isAdminMode ? (
            /* ── Admin sidebar ── */
            <nav className="flex flex-col gap-0.5 flex-1">
              <div className="px-2.5 pt-1 pb-4">
                <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-[var(--stage)]">管理后台</p>
                <p className="text-[11px] text-[#667676] mt-0.5 truncate">{currentProduction?.name}</p>
              </div>

              {ADMIN_NAV_GROUPS.map((group, gi) => (
                <div key={gi} className="flex flex-col gap-0.5">
                  {gi > 0 && (
                    <div className="mx-2.5 my-2 border-t border-[var(--line)]" />
                  )}
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

              <div className="flex-1" />
              <div className="mx-2.5 mb-2 border-t border-[var(--line)]" />

              <Link
                href={`/production/${productionId}`}
                className="flex items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 min-h-[46px] transition-colors hover:bg-white/50"
              >
                <span className="w-[27px] h-[27px] rounded-[7px] border border-[#cbd2cf] flex items-center justify-center text-[11px] text-[var(--stage)] shrink-0 leading-none">
                  ←
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-[12px] font-bold text-[var(--stage)] leading-tight">退出管理后台</span>
                  <span className="text-[9px] text-[#667676] mt-0.5 truncate">{currentProduction?.name}</span>
                </span>
              </Link>
            </nav>
          ) : (
            /* ── Regular sidebar ── */
            <nav className="flex flex-col gap-0.5 flex-1">
              {!productionId && (
                <div className="mt-1 flex flex-col gap-0.5">
                  <NavItem href="/" symbol="⌂" label="我的工作" hint="今天与我有关" active={isHome} />
                  <NavItem href="/my/projects" symbol="◈" label="我的项目" hint="管理与新建项目" active={pathname.startsWith("/my/projects")} />
                  <NavItem href="/my/announcements" symbol="⊟" label="公告" hint="演出公告与风险提醒" active={pathname.startsWith("/my/announcements")} />
                  <NavItem href="/my/weekly-call" symbol="◷" label="日程" hint="完整 Weekly Call" active={pathname.startsWith("/my/weekly-call") || pathname.startsWith("/my/daily-call")} />
                  <NavItem href="/my/tasks" symbol="✓" label="任务" hint="需求 · 跟进 · 完成" active={pathname.startsWith("/my/tasks")} badge={pendingTasks} />
                  <NavItem href="/my/notifications" symbol="◉" label="通知提醒" hint="确认与告知" active={pathname.startsWith("/my/notifications")} badge={unreadCount} />
                  <NavItem href="/my/reports" symbol="≡" label="报告" hint="所有演出报告" active={pathname.startsWith("/my/reports")} badge={unreadReports} />
                </div>
              )}

              {productionId ? (
                <>
                  <NavItem href={`/production/${productionId}`} symbol="⌂" label="我的工作" hint="今天与我有关" active={activeModule === ""} />

                  <NavGroup label="创作侧" color="script" />
                  {CREATION_NAV.map((item) => (
                    <NavItem
                      key={item.path}
                      href={navHref(item.path)}
                      symbol={item.label.charAt(0)}
                      label={item.label}
                      hint={item.hint}
                      active={isModuleActive(item.path === "cues" ? ["cues", "cuelists"] : item.path)}
                    />
                  ))}

                  <NavGroup label="制作侧" color="stage" />
                  {PRODUCTION_NAV.map((item) => (
                    <NavItem
                      key={item.path}
                      href={navHref(item.path)}
                      symbol={item.label.charAt(0)}
                      label={item.label}
                      hint={item.hint}
                      active={isModuleActive(item.path)}
                      badge={
                        item.path === "notifications" ? unreadCount :
                        item.path === "tasks" ? pendingTasks :
                        item.path === "reports" ? unreadReports :
                        undefined
                      }
                    />
                  ))}
                </>
              ) : null}
            </nav>
          )}
        </aside>

        {/* Workspace */}
        <main id="workspace-scroll" className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">{children}</main>
      </div>

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
                label="管理菜单"
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
              symbol={item.label.charAt(0)}
              label={item.label}
              hint={item.hint}
              active={isModuleActive(item.path === "cues" ? ["cues", "cuelists"] : item.path)}
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
              symbol={item.label.charAt(0)}
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
            管理后台
          </p>
          {ADMIN_NAV_GROUPS.map((group, gi) => (
            <div key={gi} className="flex flex-col gap-0.5">
              {gi > 0 && <div className="mx-2.5 my-2 border-t border-[var(--line)]" />}
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
          <div className="flex items-center gap-3 px-5 pt-1 pb-3">
            <span className="w-8 h-8 rounded-full bg-[#182a2a] text-white text-[11px] font-bold flex items-center justify-center shrink-0">
              {userInitial}
            </span>
            <span className="text-[14px] font-bold text-[#182a2a]">{session.name}</span>
          </div>
          <div className="mx-5 mb-2 border-t border-[var(--line)]" />
          <div className="px-3.5 flex flex-col gap-0.5">
            {currentProduction?.canAdmin && productionId && (
              <NavItem
                href={`/production/${productionId}/admin`}
                symbol="⚙"
                label="管理后台"
                hint={currentProduction.name}
                active={isAdminMode}
                onClick={closeDrawer}
              />
            )}
            <NavItem
              href="/account?tab=profile"
              symbol="人"
              label="个人信息"
              hint="头像 · 姓名 · 简介"
              active={pathname === "/account" && searchParams.get("tab") !== "security" && searchParams.get("tab") !== "preferences"}
              onClick={closeDrawer}
            />
            <NavItem
              href="/account?tab=security"
              symbol="盾"
              label="账号安全中心"
              hint="登录方式 · 绑定身份"
              active={pathname === "/account" && searchParams.get("tab") === "security"}
              onClick={closeDrawer}
            />
            <NavItem
              href="/account?tab=preferences"
              symbol="调"
              label="功能与设置"
              hint="通知 · 消息提醒"
              active={pathname === "/account" && searchParams.get("tab") === "preferences"}
              onClick={closeDrawer}
            />
          </div>
          <div className="mx-5 my-2 border-t border-[var(--line)]" />
          <div className="px-5">
            <form action={`${BASE_PATH}/api/auth/logout`} method="post">
              <button
                type="submit"
                className="w-full text-left flex items-center gap-2 py-2.5 text-sm text-[#667676]"
              >
                <span className="text-[11px] opacity-40">→</span>
                退出登录
              </button>
            </form>
          </div>
        </div>
      </BottomDrawer>
    </div>
  );
}
