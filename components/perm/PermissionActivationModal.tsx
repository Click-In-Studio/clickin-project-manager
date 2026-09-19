"use client";
import { useEffect } from "react";
import { permissionLabel, permissionGroupLabel } from "@/lib/perm/permission-labels";

type Props = {
  pending: string[];
  confirming: boolean;
  onConfirm: (perms: string[]) => void;
  onDismiss: () => void;
  title?: string;
  subtitle?: string;
};

/** Groups permission keys by their category label (e.g. "部门管理") */
function groupByCategory(perms: string[]): { label: string; perms: string[] }[] {
  const map = new Map<string, string[]>();
  for (const p of perms) {
    const label = permissionGroupLabel(p);
    const existing = map.get(label);
    if (existing) existing.push(p);
    else map.set(label, [p]);
  }
  return Array.from(map.entries()).map(([label, ps]) => ({ label, perms: ps }));
}

export default function PermissionActivationModal({
  pending,
  confirming,
  onConfirm,
  onDismiss,
  title = "激活权限",
  subtitle = "你拥有以下权限，确认后即可使用：",
}: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onDismiss]);

  const groups = groupByCategory(pending);

  return (
    <div
      role="presentation"
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        paddingTop: "max(clamp(12px, 4vh, 32px), env(safe-area-inset-top))",
        paddingRight: "max(clamp(8px, 4vw, 16px), env(safe-area-inset-right))",
        paddingBottom: "max(clamp(12px, 4vh, 32px), env(safe-area-inset-bottom))",
        paddingLeft: "max(clamp(8px, 4vw, 16px), env(safe-area-inset-left))",
      }}
      onClick={e => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-activation-title"
        style={{
          width: "min(440px, 100%)",
          maxHeight: "calc(100dvh - max(clamp(12px, 4vh, 32px), env(safe-area-inset-top)) - max(clamp(12px, 4vh, 32px), env(safe-area-inset-bottom)))",
          background: "var(--surface)",
          borderRadius: 16,
          boxShadow: "0 24px 80px rgba(24,42,42,.22)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "clamp(16px, 5vw, 24px) clamp(16px, 6vw, 28px) 18px",
          borderBottom: "1px solid var(--line)",
          flexShrink: 0,
        }}>
          <p style={{
            margin: "0 0 3px", fontSize: 9, fontWeight: 700,
            letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)",
          }}>
            PERMISSION ACTIVATION
          </p>
          <h2 id="perm-activation-title" style={{
            margin: 0,
            fontSize: 18, fontWeight: 600, color: "var(--ink)",
          }}>
            {title}
          </h2>
        </div>

        {/* Body */}
        <div style={{
          padding: "20px clamp(16px, 6vw, 28px)",
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehavior: "contain",
          scrollbarGutter: "stable",
          WebkitOverflowScrolling: "touch",
          touchAction: "pan-y",
        }}>
          <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
            {subtitle}
          </p>

          {/* Category chips */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {groups.map(g => (
              <div key={g.label} style={{
                display: "flex", alignItems: "flex-start",
                gap: 10, padding: "10px 14px",
                background: "var(--paper)",
                borderRadius: 10, border: "1px solid var(--line)",
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 3 }}>
                    {g.label}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>
                    {g.perms.map(permissionLabel).join("、")}
                  </div>
                </div>
                <div style={{
                  flexShrink: 0,
                  fontSize: 11, fontWeight: 600, color: "var(--muted)",
                  background: "var(--line)", borderRadius: 999,
                  padding: "2px 8px", marginTop: 1,
                }}>
                  {g.perms.length} 项
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: "14px clamp(16px, 6vw, 28px) max(16px, env(safe-area-inset-bottom))",
          display: "flex", flexWrap: "wrap", gap: 10,
          flexShrink: 0,
          borderTop: "1px solid var(--line)",
          background: "var(--surface)",
        }}>
          <button
            onClick={onDismiss}
            disabled={confirming}
            style={{
              flex: "1 1 104px", minHeight: 44, padding: "10px 12px", borderRadius: 10,
              border: "1px solid var(--line)",
              background: "transparent",
              fontSize: 13, color: "var(--muted)",
              cursor: "pointer", fontFamily: "inherit",
            }}
          >
            跳过
          </button>
          <button
            onClick={() => onConfirm(pending)}
            disabled={confirming}
            style={{
              flex: "2 1 176px", minHeight: 44, padding: "10px 12px", borderRadius: 10,
              border: "none",
              background: "var(--ink)",
              fontSize: 13, fontWeight: 600, color: "var(--paper)",
              cursor: confirming ? "wait" : "pointer",
              opacity: confirming ? 0.6 : 1,
              fontFamily: "inherit",
            }}
          >
            {confirming ? "激活中…" : `一键激活（${pending.length} 项）`}
          </button>
        </div>
      </section>
    </div>
  );
}
