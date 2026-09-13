"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { productionAvatarSrc } from "@/lib/asset/avatar-url";
import ChevronIcon from "@/components/ui/ChevronIcon";
import NewProductionModal from "../../account/NewProductionModal";
import { firstContentChar } from "./first-content-char";
import type { Production } from "./types";

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
  onOpen,
}: {
  activeProductions: Production[];
  currentProduction: Production | null;
  currentProductionId: string | null;
  canCreateProduction: boolean;
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
            </button>
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
          onCreated={id => { setNewProdOpen(false); router.push(`/production/${id}`); }}
        />
      )}
    </div>
  );
}
