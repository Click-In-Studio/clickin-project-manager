"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";

type Production = { id: string; name: string; archivedAt: string | null; roles: string[]; canAdmin: boolean };
type ShellSession = { name: string; avatarUrl: string | null };

interface AppShellProps {
  session: ShellSession | null;
  productions: Production[];
  children: React.ReactNode;
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
  { label: "任务", hint: "任务 · 节点 · 里程碑", path: "tasks" },
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

function extractProductionId(pathname: string): string | null {
  const m = pathname.match(/^\/production\/([^/]+)/);
  return m ? m[1] : null;
}

function extractModule(pathname: string, productionId: string): string {
  const base = `/production/${productionId}`;
  if (pathname === base || pathname === base + "/") return "";
  const rest = pathname.slice(base.length + 1);
  return rest.split("/")[0];
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
}: {
  href: string;
  symbol: string;
  label: string;
  hint: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 min-h-[46px] transition-colors ${
        active
          ? "bg-[var(--surface)] shadow-[inset_3px_0_0_#182a2a]"
          : "hover:bg-white/50"
      }`}
    >
      <span className="w-[27px] h-[27px] rounded-[7px] border border-[#cbd2cf] flex items-center justify-center text-[11px] text-[#667676] shrink-0 leading-none">
        {symbol}
      </span>
      <span className="flex flex-col min-w-0">
        <span className="text-[12px] font-bold text-[#182a2a] leading-tight">{label}</span>
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

function BottomNavItem({
  href,
  label,
  symbol,
  active,
}: {
  href: string;
  label: string;
  symbol: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-medium transition-colors ${
        active ? "text-[#182a2a]" : "text-[#667676]"
      }`}
    >
      <span className="text-base leading-none">{symbol}</span>
      {label}
    </Link>
  );
}

export default function AppShell({ session, productions, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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

  if (!session || pathname.startsWith("/login")) {
    return <>{children}</>;
  }

  const productionId = extractProductionId(pathname);
  const activeModule = productionId ? extractModule(pathname, productionId) : null;
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

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--paper)]">
      {/* Topbar */}
      <header className="h-16 shrink-0 bg-[var(--surface)] border-b border-[var(--line)] flex items-center gap-5 px-5 z-40">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-8 h-8 rounded-full bg-[#182a2a] text-white text-[10px] font-bold flex items-center justify-center select-none">
            CI
          </span>
          <span className="text-[13px] font-bold tracking-[0.18em] text-[#182a2a] hidden md:block">
            CLICK-IN
          </span>
        </Link>

        {/* Context controls */}
        <div className="flex items-center gap-2.5">
          <label className="flex items-center gap-2 text-[10px] text-[#667676] uppercase tracking-[0.08em]">
            <span className="hidden lg:block shrink-0">机构 / 项目</span>
            <select
              value={productionId ?? ""}
              onChange={(e) => {
                if (e.target.value) router.push(`/production/${e.target.value}`);
                else router.push("/");
              }}
              className="border border-[var(--line)] bg-[var(--paper)] rounded-lg py-2 pl-2.5 pr-7 text-[#182a2a] text-[12px] cursor-pointer outline-none focus:border-[#182a2a] max-w-[180px] lg:max-w-[240px]"
            >
              <option value="">— 选择项目 —</option>
              {activeProductions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          {productionId && currentProduction && currentProduction.roles.length > 0 && (
            <div className="flex items-center gap-2 text-[10px] text-[#667676] uppercase tracking-[0.08em]">
              <span className="hidden lg:block shrink-0">我的角色</span>
              <span className="border border-[var(--line)] bg-[var(--paper)] rounded-lg py-2 px-2.5 text-[#182a2a] text-[12px]">
                {currentProduction.roles.join(" · ")}
              </span>
            </div>
          )}
        </div>

        {/* Right actions */}
        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/my/notifications"
            className="w-9 h-9 rounded-full border border-[var(--line)] bg-[var(--surface)] flex items-center justify-center text-[#667676] hover:bg-[var(--paper)] transition-colors text-sm shrink-0"
            title="通知"
          >
            ◉
          </Link>

          {/* User dropdown */}
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
              {/* Admin mode header */}
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

              {/* Spacer */}
              <div className="flex-1" />

              <div className="mx-2.5 mb-2 border-t border-[var(--line)]" />

              {/* Exit admin */}
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
                  <NavItem href="/my/tasks" symbol="✓" label="任务" hint="需求 · 跟进 · 完成" active={pathname.startsWith("/my/tasks")} />
                  <NavItem href="/my/notifications" symbol="◉" label="通知提醒" hint="确认与告知" active={pathname.startsWith("/my/notifications")} />
                  <NavItem href="/my/reports" symbol="≡" label="报告" hint="所有演出报告" active={pathname.startsWith("/my/reports")} />
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
        <BottomNavItem href="/" label="今日" symbol="⌂" active={isHome} />
        <BottomNavItem
          href={productionId ? `/production/${productionId}` : "/"}
          label="项目"
          symbol="◇"
          active={!!productionId && activeModule === ""}
        />
        <BottomNavItem
          href={productionId ? `/production/${productionId}/tasks` : "/"}
          label="Task"
          symbol="✓"
          active={isModuleActive("tasks")}
        />
        <BottomNavItem
          href="/my/notifications"
          label="通知"
          symbol="◉"
          active={pathname.startsWith("/my/notifications")}
        />
      </nav>
    </div>
  );
}
