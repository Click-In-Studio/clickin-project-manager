/**
 * v3 内容区块语汇（原型 .panel / .panelHeading）：
 * surface 白底 + 13px 圆角 + 22px padding；heading = uppercase kicker + serif 小标题 + 右侧动作。
 */

import type { CSSProperties, ReactNode } from "react";

export const PANEL_STYLE: CSSProperties = {
  background: "var(--surface, #fff)",
  border: "1px solid var(--line)",
  borderRadius: 13,
  padding: 22,
};

export default function Panel({ kicker, title, hint, action, children, style }: {
  kicker?: string;
  title?: ReactNode;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section style={{ ...PANEL_STYLE, ...style }}>
      {(kicker || title || action) && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
          <div style={{ minWidth: 0 }}>
            {kicker && (
              <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
                {kicker}
              </p>
            )}
            {title && (
              <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>
                {title}
              </h2>
            )}
            {hint && <small style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--muted)" }}>{hint}</small>}
          </div>
          {action && <div style={{ marginLeft: "auto", flexShrink: 0 }}>{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
