"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import ChevronIcon from "@/components/ChevronIcon";
import SearchBar from "./SearchBar";
import NewProductionModal from "./NewProductionModal";
import PageActivationGate from "./PageActivationGate";
import {
  PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID,
  PRODUCTION_TOP_MENU_SEARCH_OVERFLOW_SLOT_ID,
  PRODUCTION_TOP_MENU_SLOT_ID,
  PRODUCTION_TOOLBAR_STAGE,
  ProductionToolbarContext,
  ProductionToolbarStageContext,
  type ProductionToolbarStage,
  useAnchoredMenu,
} from "./ProductionTopMenu";

type Production = { id: string; name: string; archivedAt: string | null; roles: string[]; firstTag: string | null; canAdmin: boolean; avatarUrl: string | null };
type ShellSession = { userId: string; name: string; avatarUrl: string | null };

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
  { label: "剧本", hint: "阅读 · 编辑 · 讨论", path: "script", symbol: "剧" },
  { label: "构作", hint: "章节 · 行动线", path: "dramaturgy", symbol: "构" },
  { label: "角色", hint: "角色 · 人物关系 · 聚合", path: "characters", symbol: "角" },
  { label: "Cue", hint: "部门执行设计", path: "cues", symbol: "Q" },
] as const;

const PRODUCTION_NAV = [
  { label: "人员", hint: "演员 · 部门 · 团队", path: "contacts", symbol: "人" },
  { label: "事件", hint: "围读 · 排练 · 演出", path: "events", symbol: "事" },
  { label: "任务", hint: "技术需求 · 跟进", path: "tasks", symbol: "任" },
  { label: "报告", hint: "演出报告 · 归档", path: "reports", symbol: "报" },
  { label: "通知", hint: "告知 · 确认 · 处理", path: "notifications", symbol: "通" },
  { label: "财务", hint: "预算 · 支出 · 关联", path: "finance", symbol: "财" },
  { label: "物料", hint: "道具 · 服装 · 设备", path: "materials", symbol: "物" },
  { label: "数字资产", hint: "文件 · 图纸 · 音视频", path: "assets", symbol: "数" },
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
      { label: "里程碑", hint: "阶段 · 节点", path: "milestones" },
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

const PRODUCTION_TOP_MENU_LABELS: Record<string, string> = {
  script: "剧本",
  dramaturgy: "构作",
  characters: "角色",
  cues: "Cue",
  cuelists: "Cue 表设置",
};

const PRODUCTION_TOOLBAR_UNFOLD_BUFFER_PX = 16;
const PRODUCTION_TOOLBAR_STAGES: readonly ProductionToolbarStage[] = [
  PRODUCTION_TOOLBAR_STAGE.full,
  PRODUCTION_TOOLBAR_STAGE.searchCollapsed,
  PRODUCTION_TOOLBAR_STAGE.secondaryStored,
  PRODUCTION_TOOLBAR_STAGE.primaryShort,
  PRODUCTION_TOOLBAR_STAGE.primaryStored,
  PRODUCTION_TOOLBAR_STAGE.lowPriorityStored,
];
const PRODUCTION_SIDEBAR_TRANSITION_MS = 150;
const SCROLLBAR_ACTIVITY_HIDE_DELAY_MS = 700;
// Below this width the full production sidebar no longer fits the script layout.
const SCRIPT_SIDEBAR_FOLD_THRESHOLD_PX = 1496;

type ProductionHeaderStage = 0 | 1 | 2;

function productionHeaderStageForWidth(width: number): ProductionHeaderStage {
  if (width >= 1280) return 0;
  if (width >= 1024) return 1;
  return 2;
}

function adjacentProductionToolbarStage(
  stage: ProductionToolbarStage,
  direction: -1 | 1,
): ProductionToolbarStage {
  const index = PRODUCTION_TOOLBAR_STAGES.indexOf(stage);
  return PRODUCTION_TOOLBAR_STAGES[index + direction] ?? stage;
}

function horizontalMargins(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  return (Number.parseFloat(style.marginLeft) || 0) + (Number.parseFloat(style.marginRight) || 0);
}

function outerWidth(element: HTMLElement): number {
  return element.getBoundingClientRect().width + horizontalMargins(element);
}

function productionToolbarContentWidth(slot: HTMLElement): number {
  const root = slot.querySelector<HTMLElement>("[data-production-top-menu-root]");
  if (!root) return outerWidth(slot);

  const rootStyle = window.getComputedStyle(root);
  const gap = Number.parseFloat(rootStyle.columnGap) || 0;
  const padding = (Number.parseFloat(rootStyle.paddingLeft) || 0)
    + (Number.parseFloat(rootStyle.paddingRight) || 0);
  let width = padding;
  let visibleCount = 0;

  for (const child of root.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = window.getComputedStyle(child);
    if (style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;

    const isFlexible = Number.parseFloat(style.flexGrow) > 0;
    const flexContent = isFlexible
      ? child.querySelector<HTMLElement>("[data-production-toolbar-flex-content]")
      : null;

    width += flexContent ? outerWidth(flexContent) : isFlexible ? horizontalMargins(child) : outerWidth(child);
    visibleCount += 1;
  }

  return width + Math.max(0, visibleCount - 1) * gap;
}

function productionTopbarContentWidth(topbar: HTMLElement): number {
  const style = window.getComputedStyle(topbar);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const padding = (Number.parseFloat(style.paddingLeft) || 0)
    + (Number.parseFloat(style.paddingRight) || 0);
  let width = padding;
  let visibleCount = 0;

  for (const child of topbar.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (window.getComputedStyle(child).display === "none") continue;
    width += child.id === PRODUCTION_TOP_MENU_SLOT_ID
      ? productionToolbarContentWidth(child)
      : outerWidth(child);
    visibleCount += 1;
  }

  return width + Math.max(0, visibleCount - 1) * gap;
}

const PUNCTUATION_RE = /^[\s《》「」【】『』〈〉（）()"'""''・·—–…、。，。！？]+/u;

function firstContentChar(str: string): string {
  const stripped = str.replace(PUNCTUATION_RE, "");
  return (stripped.charAt(0) || str.charAt(0)).toUpperCase();
}

function resolveAvatarSrc(userId: string, avatarUrl: string | null): string | null {
  if (!avatarUrl) return null;
  return `/api/user/avatar/${userId}`;
}

function ProdAvatarIcon({ productionId, name }: { productionId: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="text-white text-[11px] font-bold select-none">{firstContentChar(name)}</span>;
  }
  return (
    <img
      src={`${BASE_PATH}/api/production/${productionId}/avatar`}
      alt={name}
      className="w-full h-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

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
  warningBadge,
  onClick,
  folded,
  side,
}: {
  href: string;
  symbol: string;
  label: string;
  hint: string;
  active: boolean;
  /** 分侧配色（原型 scriptSymbol/stageSymbol）：创作侧青系、制作侧橙系 */
  side?: "script" | "stage";
  badge?: number;
  warningBadge?: number;
  onClick?: () => void;
  folded?: boolean;
}) {
  const foldedBadge = folded ? Math.max(badge ?? 0, warningBadge ?? 0) : 0;

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-label={folded ? `${label}${foldedBadge > 0 ? ` ${foldedBadge}` : ""}` : undefined}
      title={folded ? label : undefined}
      className={`flex min-h-[46px] items-center rounded-[9px] px-2.5 py-1.5 transition-colors ${
        folded ? "relative justify-center" : "gap-2.5 overflow-hidden"
      } ${
        active
          ? "bg-[var(--surface)] shadow-[inset_3px_0_0_#182a2a]"
          : "hover:bg-white/50"
      }`}
    >
      <span className={`flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-[7px] border text-[11px] leading-none ${
        side === "script"
          ? "border-[#bfd4d6] bg-[#edf5f5] text-[#2f6670]"
          : side === "stage"
          ? "border-[#e3c9b9] bg-[#f8eee7] text-[#a55c32]"
          : "border-[#cbd2cf] text-[#667676]"
      }`}>
        {symbol}
      </span>
      {folded ? (
        foldedBadge > 0 && (
          <span className={`absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none text-white ${
            (warningBadge ?? 0) >= foldedBadge ? "bg-amber-500" : "bg-[#c0392b]"
          }`}>
            {foldedBadge > 99 ? "99+" : foldedBadge}
          </span>
        )
      ) : (
        <span className="flex min-w-0 flex-1 flex-col overflow-hidden whitespace-nowrap">
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span className="min-w-0 truncate text-[12px] font-bold leading-tight text-[#182a2a]">{label}</span>
            {badge != null && badge > 0 && (
              <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-[#c0392b] px-1 text-[9px] font-bold leading-none text-white">
                {badge > 99 ? "99+" : badge}
              </span>
            )}
            {warningBadge != null && warningBadge > 0 && (
              <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold leading-none text-white">
                {warningBadge > 99 ? "99+" : warningBadge}
              </span>
            )}
          </span>
          <span className="mt-0.5 truncate text-[9px] text-[#667676]">{hint}</span>
        </span>
      )}
    </Link>
  );
}

function NavGroup({ label, color, folded }: { label: string; color: "script" | "stage"; folded?: boolean }) {
  // v3：分组标题为深色填充条（原型 navGroupTitle）——创作侧 ink、制作侧深棕
  return (
    <div
      className={`mt-[15px] mb-1 flex items-center gap-2 rounded-[8px] text-white ${
        folded ? "min-h-[28px] justify-center px-0" : "min-h-[32px] px-[11px]"
      } ${color === "script" ? "bg-[#182a2a]" : "bg-[#4d3328]"}`}
      title={folded ? label : undefined}
    >
      <span
        className={`w-[7px] h-[7px] rounded-full shrink-0 ${
          color === "script" ? "bg-[#7fc0c7]" : "bg-[#e9a578]"
        }`}
      />
      {!folded && (
        <span className="whitespace-nowrap text-[10px] font-bold tracking-[0.12em] uppercase text-[#f4f7f5]">
          {label}
        </span>
      )}
    </div>
  );
}

function DropdownItem({ href, onClick, children }: { href: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2 px-2.5 py-2 rounded-[7px] text-[11px] text-[#182a2a] hover:bg-[var(--paper)] transition-colors"
    >
      {children}
    </Link>
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

function MenuProdAvatar({ productionId, name }: { productionId: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{firstContentChar(name)}</>;
  return (
    <img
      src={`${BASE_PATH}/api/production/${productionId}/avatar`}
      alt=""
      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      onError={() => setFailed(true)}
    />
  );
}

function ProjectSwitcher({
  activeProductions,
  currentProduction,
  currentProductionId,
  onOpen,
}: {
  activeProductions: Production[];
  currentProduction: Production | null;
  currentProductionId: string | null;
  onOpen?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [btnHovered, setBtnHovered] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [newProdOpen, setNewProdOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const navigate = (id: string | null) => {
    setOpen(false);
    if (id) router.push(`/production/${id}`);
    else router.push("/");
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) onOpen?.();
  };

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      {/* Switcher button */}
      <button
        onClick={toggle}
        aria-expanded={open}
        onMouseEnter={() => setBtnHovered(true)}
        onMouseLeave={() => setBtnHovered(false)}
        style={{
          height: 44,
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: `1px solid ${btnHovered || open ? "var(--ink)" : "var(--line)"}`,
          borderRadius: 10,
          background: "var(--paper)",
          cursor: "pointer",
          textAlign: "left",
          minWidth: 180,
          maxWidth: 280,
          transition: "border-color .12s",
        }}
      >
        <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column" }}>
          {currentProduction ? (
            <>
              {currentProduction.roles.length > 0 && (
                <small style={{
                  color: "var(--muted)", fontSize: 10, lineHeight: 1.2,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {currentProduction.roles[0]}
                  {currentProduction.firstTag && (
                    <span style={{ marginLeft: 3, opacity: 0.7 }}>[{currentProduction.firstTag}]</span>
                  )}
                </small>
              )}
              <b style={{
                fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                marginTop: currentProduction.roles.length > 0 ? 2 : 0,
              }}>
                {currentProduction.name}
              </b>
            </>
          ) : (
            <b style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>选择项目</b>
          )}
        </span>
        <ChevronIcon
          direction={open ? "up" : "down"}
          size={12}
          className="shrink-0 text-[var(--muted)]"
        />
      </button>

      {/* Popover dropdown */}
      {open && (
        <div style={{
          position: "absolute",
          zIndex: 40,
          top: "calc(100% + 10px)",
          left: 0,
          minWidth: 270,
          padding: 8,
          border: "1px solid var(--line)",
          borderRadius: 13,
          background: "var(--surface)",
          boxShadow: "0 18px 55px rgba(24,42,42,.18)",
        }}>
          {/* Caret arrow */}
          <div style={{
            position: "absolute",
            top: -5,
            left: 20,
            width: 9,
            height: 9,
            transform: "rotate(45deg)",
            borderLeft: "1px solid var(--line)",
            borderTop: "1px solid var(--line)",
            background: "var(--surface)",
          }} />

          {/* Platform home */}
          <button
            onClick={() => navigate(null)}
            onMouseEnter={() => setHoveredItem("__home__")}
            onMouseLeave={() => setHoveredItem(null)}
            style={{
              width: "100%", minHeight: 44, padding: "7px 9px",
              display: "flex", alignItems: "center", gap: 10,
              border: 0, borderRadius: 9,
              background: !currentProductionId || hoveredItem === "__home__" ? "var(--paper)" : "transparent",
              textAlign: "left", cursor: "pointer",
            }}
          >
            <span style={{
              width: 31, height: 31, display: "grid", placeItems: "center", flexShrink: 0,
              borderRadius: "50%", background: "var(--ink)", color: "#fff", fontSize: 13,
            }}>
              ⌂
            </span>
            <span style={{ display: "flex", flex: 1, flexDirection: "column" }}>
              <b style={{ fontSize: 13 }}>平台首页</b>
              <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 10 }}>跨项目总览</small>
            </span>
            {!currentProductionId && (
              <span style={{ color: "var(--success)", fontSize: 13, flexShrink: 0 }}>✓</span>
            )}
          </button>

          {activeProductions.length > 0 && (
            <p style={{
              margin: "8px 10px 4px", color: "var(--muted)",
              fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase",
            }}>
              我的项目
            </p>
          )}

          {activeProductions.map(p => (
            <button
              key={p.id}
              onClick={() => navigate(p.id)}
              onMouseEnter={() => setHoveredItem(p.id)}
              onMouseLeave={() => setHoveredItem(null)}
              style={{
                width: "100%", minHeight: 49, padding: "7px 9px",
                display: "flex", alignItems: "center", gap: 10,
                border: 0, borderRadius: 9,
                background: p.id === currentProductionId || hoveredItem === p.id ? "var(--paper)" : "transparent",
                textAlign: "left", cursor: "pointer",
              }}
            >
              <span style={{
                width: 34, height: 34, display: "grid", placeItems: "center", flexShrink: 0,
                borderRadius: 9, overflow: "hidden",
                background: "var(--script-soft)", color: "var(--script)",
                fontFamily: "Georgia, serif", fontSize: 14, fontWeight: 700,
              }}>
                <MenuProdAvatar productionId={p.id} name={p.name} />
              </span>
              <span style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0 }}>
                <b style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.name}
                </b>
                {p.roles.length > 0 && (
                  <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 10 }}>
                    {p.roles[0]}
                    {p.firstTag && (
                      <span style={{ marginLeft: 3, opacity: 0.7 }}>[{p.firstTag}]</span>
                    )}
                  </small>
                )}
              </span>
              {p.id === currentProductionId && (
                <span style={{ color: "var(--success)", fontSize: 13, flexShrink: 0 }}>✓</span>
              )}
            </button>
          ))}

          {activeProductions.length === 0 && (
            <p style={{ padding: "12px 9px", fontSize: 13, color: "var(--muted)", textAlign: "center" }}>
              暂无活跃项目
            </p>
          )}

          {/* New project */}
          <button
            onClick={() => { setOpen(false); setNewProdOpen(true); }}
            onMouseEnter={() => setHoveredItem("__new__")}
            onMouseLeave={() => setHoveredItem(null)}
            style={{
              width: "100%", minHeight: 44, padding: "7px 9px",
              display: "flex", alignItems: "center", gap: 10,
              border: 0, borderTop: "1px solid var(--line)",
              borderRadius: "0 0 9px 9px",
              background: hoveredItem === "__new__" ? "var(--paper)" : "transparent",
              textAlign: "left", cursor: "pointer", marginTop: 4,
            }}
          >
            <span style={{
              width: 31, height: 31, display: "grid", placeItems: "center", flexShrink: 0,
              borderRadius: 9, border: "1.5px dashed var(--line)",
              color: "var(--script)", fontSize: 18, lineHeight: 1,
            }}>
              +
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--script)" }}>新建项目</span>
          </button>
        </div>
      )}

      {newProdOpen && (
        <NewProductionModal
          onClose={() => setNewProdOpen(false)}
          onCreated={id => { setNewProdOpen(false); router.push(`/production/${id}`); }}
        />
      )}
    </div>
  );
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
  const [cueWarnings, setCueWarnings] = useState(0);
  const [productionHeaderStage, setProductionHeaderStage] = useState<ProductionHeaderStage>(0);
  const [productionToolbarStage, setProductionToolbarStage] = useState<ProductionToolbarStage>(0);
  const [productionToolbarHasStoredControls, setProductionToolbarHasStoredControls] = useState(false);
  const [scriptProductionSidebarAutoFolded, setScriptProductionSidebarAutoFolded] = useState(false);
  const [scriptProductionSidebarManuallyFolded, setScriptProductionSidebarManuallyFolded] = useState(false);
  // v3：非剧本类页面的全局侧栏折叠（原型 sidebarControls toggle）
  const [generalSidebarFolded, setGeneralSidebarFolded] = useState(false);
  const [scriptProductionSidebarOverlayOpen, setScriptProductionSidebarOverlayOpen] = useState(false);
  const [scriptProductionSidebarContentFolded, setScriptProductionSidebarContentFolded] = useState(false);
  const [topOverflowOpen, setTopOverflowOpen] = useState(false);
  const [productionSearchPath, setProductionSearchPath] = useState<string | null>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const topOverflowRef = useRef<HTMLDivElement>(null);
  const productionSearchOpenRef = useRef(false);
  const productionToolbarStageRef = useRef<ProductionToolbarStage>(productionToolbarStage);
  const productionToolbarHasStoredControlsRef = useRef(productionToolbarHasStoredControls);
  const productionToolbarRequiredWidthRef = useRef<Partial<Record<ProductionToolbarStage, number>>>({});
  productionToolbarStageRef.current = productionToolbarStage;
  productionToolbarHasStoredControlsRef.current = productionToolbarHasStoredControls;
  const closeTopOverflow = useCallback(() => setTopOverflowOpen(false), []);
  const topOverflowMenu = useAnchoredMenu<HTMLButtonElement>(topOverflowOpen, "bottom");
  const handleProductionSearchOpenChange = useCallback((open: boolean, stored: boolean) => {
    productionSearchOpenRef.current = open;
    if (open && !stored) closeTopOverflow();
    setProductionSearchPath(open && !stored ? pathname : null);
  }, [pathname, closeTopOverflow]);
  const productionToolbarContext = useMemo(() => ({
    stage: productionToolbarStage,
    closeOverflow: closeTopOverflow,
    overflowOpen: topOverflowOpen,
    hasStoredControls: productionToolbarHasStoredControls,
    setHasStoredControls: setProductionToolbarHasStoredControls,
  }), [productionToolbarStage, productionToolbarHasStoredControls, topOverflowOpen, closeTopOverflow]);

  useLayoutEffect(() => {
    const syncHeaderStage = () => setProductionHeaderStage(productionHeaderStageForWidth(window.innerWidth));
    syncHeaderStage();
    window.addEventListener("resize", syncHeaderStage);
    return () => window.removeEventListener("resize", syncHeaderStage);
  }, []);

  const measureProductionToolbar = useCallback(() => {
    const topbar = topbarRef.current;
    if (!topbar) return;
    if (productionSearchOpenRef.current) return;

    const current = productionToolbarStageRef.current;
    if (!topbar.querySelector(`#${PRODUCTION_TOP_MENU_SLOT_ID}`)) return;
    const overflowTarget = topbar.querySelector(`#${PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID}`);
    if (!!overflowTarget?.childElementCount !== productionToolbarHasStoredControlsRef.current) return;

    const overflow = productionTopbarContentWidth(topbar) - topbar.clientWidth;
    if (overflow > 1 && current < PRODUCTION_TOOLBAR_STAGE.lowPriorityStored) {
      productionToolbarRequiredWidthRef.current[current] = topbar.clientWidth + overflow;
      setProductionToolbarStage(adjacentProductionToolbarStage(current, 1));
      return;
    }

    if (current > 0) {
      const previous = adjacentProductionToolbarStage(current, -1);
      const previousRequiredWidth = productionToolbarRequiredWidthRef.current[previous];
      if (previousRequiredWidth && topbar.clientWidth >= previousRequiredWidth + PRODUCTION_TOOLBAR_UNFOLD_BUFFER_PX) {
        setProductionToolbarStage(previous);
      }
    }
  }, []);

  useLayoutEffect(() => {
    measureProductionToolbar();
  }, [productionSearchPath, productionHeaderStage, productionToolbarStage, productionToolbarHasStoredControls, measureProductionToolbar]);

  useEffect(() => {
    const topbar = topbarRef.current;
    if (!topbar) return;
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measureProductionToolbar();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    resizeObserver.observe(topbar);
    mutationObserver.observe(topbar, { childList: true, characterData: true, subtree: true });
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [measureProductionToolbar]);

  useLayoutEffect(() => {
    productionToolbarRequiredWidthRef.current = {};
    productionToolbarStageRef.current = 0;
    setProductionToolbarStage(0);
  }, [pathname]);

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

  useLayoutEffect(() => {
    closeTopOverflow();
  }, [productionToolbarStage, productionToolbarHasStoredControls, closeTopOverflow]);

  // Track current productionId via ref so fetchCounts always uses the latest value
  // without needing to be in the effect dependency array.
  const currentProductionIdRef = useRef<string | null>(extractProductionId(pathname));
  currentProductionIdRef.current = extractProductionId(pathname);

  // Expose fetchCounts via ref so the production-switch effect can call it.
  const fetchCountsRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setDrawerOpen(null);
    setProductionSearchPath(null);
    productionSearchOpenRef.current = false;
    setTopOverflowOpen(false);
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
        setCueWarnings(0);
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
        .then((d: { notifications?: number; tasks?: number; reports?: number; cueWarnings?: number }) => {
          if (typeof d.notifications === "number") setUnreadCount(d.notifications);
          if (typeof d.tasks === "number") setPendingTasks(d.tasks);
          if (typeof d.reports === "number") setUnreadReports(d.reports);
          if (typeof d.cueWarnings === "number") setCueWarnings(d.cueWarnings);
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

  useEffect(() => {
    if (!topOverflowOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (topOverflowRef.current?.contains(target as Node)) return;
      if (target instanceof Element && target.closest("[data-production-overflow-menu-child]")) return;
      closeTopOverflow();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [topOverflowOpen, closeTopOverflow]);

  const isScriptPage = /^\/production\/[^/]+\/script(?:\/|$)/.test(pathname);
  useLayoutEffect(() => {
    if (!isScriptPage) {
      setScriptProductionSidebarAutoFolded(false);
      setScriptProductionSidebarManuallyFolded(false);
      setScriptProductionSidebarOverlayOpen(false);
      setScriptProductionSidebarContentFolded(false);
      return;
    }

    const foldQuery = window.matchMedia(`(max-width: ${SCRIPT_SIDEBAR_FOLD_THRESHOLD_PX - 1}px)`);
    const hiddenQuery = window.matchMedia("(max-width: 1023px)");
    const syncSidebarState = () => {
      const autoFolded = foldQuery.matches;
      setScriptProductionSidebarAutoFolded(autoFolded);
      if (!autoFolded || hiddenQuery.matches) setScriptProductionSidebarOverlayOpen(false);
    };
    syncSidebarState();
    foldQuery.addEventListener("change", syncSidebarState);
    hiddenQuery.addEventListener("change", syncSidebarState);
    return () => {
      foldQuery.removeEventListener("change", syncSidebarState);
      hiddenQuery.removeEventListener("change", syncSidebarState);
    };
  }, [isScriptPage]);

  const productionSidebarOverlayOpen = isScriptPage
    && scriptProductionSidebarAutoFolded
    && scriptProductionSidebarOverlayOpen;
  const productionSidebarFolded = isScriptPage
    ? (scriptProductionSidebarAutoFolded
        ? !productionSidebarOverlayOpen
        : scriptProductionSidebarManuallyFolded)
    : generalSidebarFolded;
  const productionSidebarContentFolded = isScriptPage ? scriptProductionSidebarContentFolded : generalSidebarFolded;
  useEffect(() => {
    if (!isScriptPage) return;
    const timer = window.setTimeout(
      () => setScriptProductionSidebarContentFolded(productionSidebarFolded),
      PRODUCTION_SIDEBAR_TRANSITION_MS + 20,
    );
    return () => window.clearTimeout(timer);
  }, [isScriptPage, productionSidebarFolded]);

  if (!session || pathname.startsWith("/login")) {
    return <>{children}</>;
  }

  const isUnauthorizedPage = pathname.startsWith("/unauthorized");
  const productionId = extractProductionId(pathname) ?? (isUnauthorizedPage ? searchParams.get("id") : null);
  const activeModule = productionId && pathname.startsWith(`/production/${productionId}`)
    ? extractModule(pathname, productionId)
    : null;
  const hasProductionTopMenu = !!activeModule && ["script", "dramaturgy", "characters", "cues", "cuelists"].includes(activeModule);
  const isHome = pathname === "/";
  const currentProduction = productionId
    ? productions.find((p) => p.id === productionId)
    : null;
  const activeProductions = productions.filter((p) => !p.archivedAt);
  const isAdminMode = !!(productionId && pathname.startsWith(`/production/${productionId}/admin`));
  const activeAdminModule = isAdminMode ? extractAdminModule(pathname, productionId!) : null;
  const toggleScriptProductionSidebar = () => {
    if (scriptProductionSidebarAutoFolded) {
      setScriptProductionSidebarOverlayOpen((open) => !open);
      return;
    }
    setScriptProductionSidebarManuallyFolded((folded) => !folded);
  };

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

  const userInitial = firstContentChar(session.name);
  const avatarSrc = resolveAvatarSrc(session.userId, session.avatarUrl);
  const avatarSymbol = (
    <span className="relative">
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt=""
          className="w-5 h-5 rounded-full object-cover"
        />
      ) : (
        <span className="w-5 h-5 rounded-full bg-[#182a2a] text-white text-[9px] font-bold flex items-center justify-center">
          {userInitial}
        </span>
      )}
      {unreadCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#c0392b] border border-[var(--paper)]" />
      )}
    </span>
  );

  return (
    <ProductionToolbarStageContext.Provider value={productionToolbarStage}>
    <ProductionToolbarContext.Provider value={productionToolbarContext}>
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--paper)]">
      {/* Topbar */}
      <header ref={topbarRef} className="h-16 shrink-0 bg-[var(--surface)] border-b border-[var(--line)] flex items-center gap-5 px-5 z-50">
        {/* Brand / production icon */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-8 h-8 rounded-full bg-[#182a2a] overflow-hidden flex items-center justify-center select-none shrink-0">
            {productionId && currentProduction ? (
              currentProduction.avatarUrl ? (
                <ProdAvatarIcon productionId={productionId} name={currentProduction.name} />
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
          onOpen={() => setDropdownOpen(false)}
        />

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

          {/* Notification bell: sm+ only */}
          <Link
            href={productionId ? `/production/${productionId}/notifications` : "/my/notifications"}
            className={`relative ${productionHeaderStage >= 2 ? "hidden" : "flex"} w-9 h-9 rounded-full border border-[var(--line)] bg-[var(--surface)] items-center justify-center text-[#667676] hover:bg-[var(--paper)] transition-colors text-sm shrink-0`}
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

          {/* User avatar + dropdown: sm+ only */}
          <div className={`relative shrink-0 ${productionHeaderStage >= 2 ? "hidden" : "block"}`} ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              aria-label="个人中心"
              aria-expanded={dropdownOpen}
              className="relative w-9 h-9 rounded-full border border-[var(--line)] overflow-hidden bg-[#182a2a] flex items-center justify-center hover:opacity-90 transition-opacity shrink-0"
            >
              {avatarSrc ? (
                <img src={avatarSrc} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-white text-[11px] font-bold">{userInitial}</span>
              )}
              {unreadCount > 0 && (
                <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-[#c0392b] border-2 border-[var(--surface)]" />
              )}
            </button>

            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-2.5 w-[240px] bg-[var(--surface)] border border-[var(--line)] rounded-[13px] shadow-[0_18px_55px_rgba(24,42,42,.18)] z-50 overflow-hidden p-2">
                {/* ── 用户概要 ── */}
                <div className="flex items-center gap-2.5 px-2 py-2 mb-1 border-b border-[var(--line)]">
                  <span className="w-9 h-9 rounded-full bg-[#182a2a] overflow-hidden shrink-0 flex items-center justify-center">
                    {avatarSrc ? (
                      <img src={avatarSrc} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-white text-[11px] font-bold">{userInitial}</span>
                    )}
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-bold text-[#182a2a] truncate">{session.name}</span>
                  </div>
                </div>

                {/* ── 账户 ── */}
                <DropdownItem href="/account?tab=profile" onClick={() => setDropdownOpen(false)}>个人信息</DropdownItem>
                <DropdownItem href="/account?tab=security" onClick={() => setDropdownOpen(false)}>账号安全中心</DropdownItem>

                {/* ── 偏好 ── */}
                <div className="h-px bg-[var(--line)] mx-1 my-1.5" />
                <DropdownItem href="/account?tab=preferences" onClick={() => setDropdownOpen(false)}>功能与设置</DropdownItem>

                {/* ── 管理后台 ── */}
                {currentProduction?.canAdmin && productionId && (
                  <>
                    <div className="h-px bg-[var(--line)] mx-1 my-1.5" />
                    <DropdownItem href={`/production/${productionId}/admin`} onClick={() => setDropdownOpen(false)}>
                      管理后台
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
                  <NavItem href="/" symbol="⌂" label="我的工作" hint="今天与我有关" active={isHome} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/projects" symbol="◈" label="我的项目" hint="管理与新建项目" active={pathname.startsWith("/my/projects")} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/announcements" symbol="⊟" label="公告" hint="演出公告与风险提醒" active={pathname.startsWith("/my/announcements")} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/weekly-call" symbol="◷" label="日程" hint="完整 Weekly Call" active={pathname.startsWith("/my/weekly-call") || pathname.startsWith("/my/daily-call")} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/tasks" symbol="✓" label="任务" hint="需求 · 跟进 · 完成" active={pathname.startsWith("/my/tasks")} badge={pendingTasks} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/notifications" symbol="◉" label="通知提醒" hint="确认与告知" active={pathname.startsWith("/my/notifications")} badge={unreadCount} folded={productionSidebarContentFolded} />
                  <NavItem href="/my/reports" symbol="≡" label="报告" hint="所有演出报告" active={pathname.startsWith("/my/reports")} badge={unreadReports} folded={productionSidebarContentFolded} />
                </div>
              )}

              {productionId ? (
                <>
                  <NavItem href={`/production/${productionId}`} symbol="⌂" label="我的工作" hint="今天与我有关" active={activeModule === ""} folded={productionSidebarContentFolded} />
                  <NavItem href={navHref("announcements")} symbol="⊟" label="项目公告" hint="公告 · 置顶 · 全览" active={isModuleActive("announcements")} folded={productionSidebarContentFolded} />
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
                      active={isModuleActive(item.path === "cues" ? ["cues", "cuelists"] : item.path)}
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
                        item.path === "notifications" ? unreadCount :
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
        <main id="workspace-scroll" className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">{children}</main>
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
              symbol={item.symbol}
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
          {/* 用户概要 */}
          <div className="flex items-center gap-3 px-5 pt-1 pb-3">
            <span className="w-10 h-10 rounded-full bg-[#182a2a] overflow-hidden shrink-0 flex items-center justify-center">
              {avatarSrc ? (
                <img src={avatarSrc} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-white text-[13px] font-bold">{userInitial}</span>
              )}
            </span>
            <span className="text-[14px] font-bold text-[#182a2a]">{session.name}</span>
          </div>
          <div className="mx-5 border-t border-[var(--line)]" />

          {/* 账户 */}
          <div className="px-3.5 pt-1 flex flex-col gap-0.5">
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
          </div>

          {/* 偏好 */}
          <div className="mx-5 my-1.5 border-t border-[var(--line)]" />
          <div className="px-3.5 flex flex-col gap-0.5">
            <NavItem
              href="/account?tab=preferences"
              symbol="调"
              label="功能与设置"
              hint="通知 · 消息提醒"
              active={pathname === "/account" && searchParams.get("tab") === "preferences"}
              onClick={closeDrawer}
            />
          </div>

          {/* 管理后台 */}
          {currentProduction?.canAdmin && productionId && (
            <>
              <div className="mx-5 my-1.5 border-t border-[var(--line)]" />
              <div className="px-3.5 flex flex-col gap-0.5">
                <NavItem
                  href={`/production/${productionId}/admin`}
                  symbol="⚙"
                  label="管理后台"
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
    </div>
    </ProductionToolbarContext.Provider>
    </ProductionToolbarStageContext.Provider>
  );
}
