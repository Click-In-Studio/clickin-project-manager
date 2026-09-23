"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect, useRef, useContext, useTransition, type MouseEvent as ReactMouseEvent } from "react";
import { productionAvatarSrc } from "@/lib/asset/avatar-url";
import ChevronIcon from "@/components/ui/ChevronIcon";
import NewProductionModal from "../../account/NewProductionModal";
import { firstContentChar } from "./first-content-char";
import { NavPendingContext } from "./nav-pending";
import type { Production } from "./types";

/** 带修饰键 / 非左键的点击交给浏览器（新标签页打开），不走站内软导航。 */
function isModifiedClick(e: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

function MenuProdAvatar({ productionId, avatarUrl, name }: { productionId: string; avatarUrl: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const src = productionAvatarSrc(productionId, avatarUrl);
  if (failed || !src) return <>{firstContentChar(name)}</>;
  return (
    <img
      src={src}
      alt=""
      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      onError={() => setFailed(true)}
    />
  );
}

export default function ProjectSwitcher({
  activeProductions,
  currentProduction,
  currentProductionId,
  canCreateProduction,
  compact = false,
  onOpen,
}: {
  activeProductions: Production[];
  currentProduction: Production | null;
  currentProductionId: string | null;
  canCreateProduction: boolean;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const router = useRouter();
  // #651 在途态：软导航要等目标项目的 RSC payload 回来才换 pathname，而按钮上的
  // 项目名 / 侧栏高亮都从 pathname 推导——点完什么都不动，用户以为没点上就连点。
  // navigate() 走 startTransition 拿到 isPending，等待期间按钮先换成目标项目名 +
  // 转圈；同时把目标 href 报给 NavPendingContext，让侧栏立刻离开旧项目的高亮
  // （与 NavItem 的 useLinkStatus 同一套语汇）。
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const pendingTarget = isPending ? pendingHref : null;
  const { report } = useContext(NavPendingContext);
  useEffect(() => {
    if (!pendingTarget) return;
    report(pendingTarget, true);
    // 落地 / 换目标 / 卸载都撤回；归约规则（连点、撤回晚到）见 lib/nav-pending.ts。
    return () => report(pendingTarget, false);
  }, [pendingTarget, report]);
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
    const href = id ? `/production/${id}` : "/";
    setPendingHref(href);
    startTransition(() => router.push(href));
  };
  // 菜单项是 <Link>（顺带 hover prefetch）：普通左键截下来走 navigate 拿在途态，
  // 修饰键点击放行给浏览器开新标签。在途期间不再接受新目标。
  const onItemClick = (id: string | null) => (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (isModifiedClick(e)) return;
    e.preventDefault();
    if (isPending) return;
    navigate(id);
  };
  // 在途期间按钮显示目标而不是旧项目：去平台首页显示「平台首页」，去项目显示该项目；
  // 目标不在列表里（刚新建的项目，layout 还没 refresh）就仍显示当前项目，只转圈。
  const shownProduction = pendingTarget === "/"
    ? null
    : pendingTarget
      ? activeProductions.find(p => `/production/${p.id}` === pendingTarget) ?? currentProduction
      : currentProduction;

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
        aria-busy={isPending || undefined}
        onMouseEnter={() => setBtnHovered(true)}
        onMouseLeave={() => setBtnHovered(false)}
        style={{
          height: compact ? 38 : 44,
          padding: compact ? "6px 9px" : "8px 12px",
          display: "flex",
          alignItems: "center",
          gap: compact ? 6 : 10,
          border: `1px solid ${btnHovered || open ? "var(--ink)" : "var(--line)"}`,
          borderRadius: 10,
          background: "var(--paper)",
          cursor: "pointer",
          textAlign: "left",
          minWidth: compact ? 112 : 180,
          width: compact ? "clamp(112px, 31vw, 148px)" : undefined,
          maxWidth: compact ? 148 : 280,
          transition: "border-color .12s",
        }}
      >
        <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", opacity: isPending ? 0.7 : 1, transition: "opacity .12s" }}>
          {shownProduction ? (
            <>
              {shownProduction.roles.length > 0 && (
                <small style={{
                  color: "var(--muted)", fontSize: compact ? 9 : 10, lineHeight: 1.15,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {shownProduction.roles[0]}
                  {shownProduction.firstTag && (
                    <span style={{ marginLeft: 3, opacity: 0.7 }}>[{shownProduction.firstTag}]</span>
                  )}
                </small>
              )}
              <b style={{
                fontSize: compact ? 11 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                marginTop: shownProduction.roles.length > 0 ? (compact ? 1 : 2) : 0,
              }}>
                {shownProduction.name}
              </b>
            </>
          ) : pendingTarget === "/" ? (
            <b style={{ fontSize: compact ? 11 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>平台首页</b>
          ) : (
            <b style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>选择项目</b>
          )}
        </span>
        {isPending ? (
          <span
            data-testid="project-switcher-spinner"
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent text-[var(--muted)]"
            aria-hidden
          />
        ) : (
          <ChevronIcon
            direction={open ? "up" : "down"}
            size={12}
            className="shrink-0 text-[var(--muted)]"
          />
        )}
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
          <Link
            href="/"
            onClick={onItemClick(null)}
            aria-disabled={isPending || undefined}
            onMouseEnter={() => setHoveredItem("__home__")}
            onMouseLeave={() => setHoveredItem(null)}
            style={{
              width: "100%", minHeight: 44, padding: "7px 9px",
              display: "flex", alignItems: "center", gap: 10,
              border: 0, borderRadius: 9,
              background: !currentProductionId || hoveredItem === "__home__" ? "var(--paper)" : "transparent",
              textAlign: "left", cursor: isPending ? "default" : "pointer",
              opacity: isPending ? 0.5 : 1,
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
          </Link>

          {activeProductions.length > 0 && (
            <p style={{
              margin: "8px 10px 4px", color: "var(--muted)",
              fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase",
            }}>
              我的项目
            </p>
          )}

          {activeProductions.map(p => (
            <Link
              key={p.id}
              href={`/production/${p.id}`}
              onClick={onItemClick(p.id)}
              aria-disabled={isPending || undefined}
              onMouseEnter={() => setHoveredItem(p.id)}
              onMouseLeave={() => setHoveredItem(null)}
              style={{
                width: "100%", minHeight: 49, padding: "7px 9px",
                display: "flex", alignItems: "center", gap: 10,
                border: 0, borderRadius: 9,
                background: p.id === currentProductionId || hoveredItem === p.id ? "var(--paper)" : "transparent",
                textAlign: "left", cursor: isPending ? "default" : "pointer",
                opacity: isPending ? 0.5 : 1,
              }}
            >
              <span style={{
                width: 34, height: 34, display: "grid", placeItems: "center", flexShrink: 0,
                borderRadius: 9, overflow: "hidden",
                background: "var(--script-soft)", color: "var(--script)",
                fontFamily: "Georgia, serif", fontSize: 14, fontWeight: 700,
              }}>
                <MenuProdAvatar productionId={p.id} avatarUrl={p.avatarUrl} name={p.name} />
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
            </Link>
          ))}

          {activeProductions.length === 0 && (
            <p style={{ padding: "12px 9px", fontSize: 13, color: "var(--muted)", textAlign: "center" }}>
              暂无活跃项目
            </p>
          )}

          {/* New project — 用户等级（付费维度）决定这一项在不在菜单里 */}
          {canCreateProduction && (
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
          )}
        </div>
      )}

      {newProdOpen && (
        <NewProductionModal
          onClose={() => setNewProdOpen(false)}
          // 项目列表是 root layout SSR 下发的 props，软导航不重渲 layout（#528）：
          // 只 push 的话侧栏切换器里没有新项目，非手动刷新不可。refresh 让 layout 重跑。
          // 顺序不能反：Next 的 action queue 里 navigate 优先，会把排在它前面还没跑的
          // refresh 标成 discarded；push 在前则 refresh 串行跑在导航后的新 URL 上。
          // 同样走 startTransition：新项目落地前按钮就显示转圈（#651）。
          onCreated={id => {
            setNewProdOpen(false);
            const href = `/production/${id}`;
            setPendingHref(href);
            startTransition(() => { router.push(href); router.refresh(); });
          }}
        />
      )}
    </div>
  );
}
