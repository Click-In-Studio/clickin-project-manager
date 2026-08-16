/**
 * v3 统一页头（原型 pageHeader 语汇）：
 * uppercase eyebrow + serif 大标题 + 右侧场景动作区。
 * 页面级主/次按钮样式一并导出，保证"每页一个场景主按钮"的一致形态。
 */

import type { CSSProperties, ReactNode } from "react";

export const PAGE_TITLE_FONT = 'Georgia, "Noto Serif SC", serif';

export const PRIMARY_BTN: CSSProperties = {
  borderRadius: 8, padding: "10px 14px", border: "1px solid var(--ink)",
  cursor: "pointer", fontSize: 12, fontWeight: 700,
  background: "var(--ink)", color: "#fff", whiteSpace: "nowrap",
};

export const SECONDARY_BTN: CSSProperties = {
  borderRadius: 8, padding: "10px 14px", border: "1px solid var(--ink)",
  cursor: "pointer", fontSize: 12, fontWeight: 700,
  background: "transparent", color: "var(--ink)", whiteSpace: "nowrap",
};

export default function PageHeader({ eyebrow, title, side, actions, children }: {
  eyebrow: string;
  title: ReactNode;
  /** 创作侧 script / 制作侧 stage —— eyebrow 用对应主题色 */
  side?: "script" | "stage";
  actions?: ReactNode;
  /** 标题下方补充内容（如状态徽章行） */
  children?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 20, marginBottom: 22, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        <p style={{
          margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em",
          textTransform: "uppercase",
          color: side === "script" ? "var(--script, var(--muted))" : side === "stage" ? "var(--stage, var(--muted))" : "var(--muted)",
        }}>
          {eyebrow}
        </p>
        <h1 style={{
          margin: "5px 0 0", fontFamily: PAGE_TITLE_FONT,
          fontSize: "clamp(26px, 3vw, 38px)", fontWeight: 500,
          letterSpacing: "-.04em", color: "var(--ink)", lineHeight: 1.15,
        }}>
          {title}
        </h1>
        {children}
      </div>
      {actions && (
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {actions}
        </div>
      )}
    </div>
  );
}
