"use client";
import { useEffect } from "react";
import { PERMISSION_LABELS, GROUP_LABELS } from "@/lib/permission-labels";

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
    // 节点键（node:<type>/...）按资源类型分组
    const prefix = p.startsWith("node:") ? p.slice(5).split("/")[0] ?? p : p.split(":")[0] ?? p;
    const label = GROUP_LABELS[prefix] ?? prefix;
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
        padding: "0 16px",
      }}
      onClick={e => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-activation-title"
        style={{
          width: "min(440px, 100%)",
          background: "var(--surface)",
          borderRadius: 16,
          boxShadow: "0 24px 80px rgba(24,42,42,.22)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "24px 28px 18px",
          borderBottom: "1px solid var(--line)",
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
        <div style={{ padding: "20px 28px" }}>
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
                    {g.perms
                      .map(p => PERMISSION_LABELS[p as keyof typeof PERMISSION_LABELS] ?? p)
                      .join("、")}
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
          padding: "0 28px 24px",
          display: "flex", gap: 10,
        }}>
          <button
            onClick={onDismiss}
            disabled={confirming}
            style={{
              flex: 1, padding: "10px 0", borderRadius: 10,
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
              flex: 2, padding: "10px 0", borderRadius: 10,
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
