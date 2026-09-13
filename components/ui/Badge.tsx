/** v3 徽章语汇（原型 .badge + tone 变体）。 */

import type { CSSProperties, ReactNode } from "react";

const TONES: Record<string, CSSProperties> = {
  neutral: { background: "var(--surface-2)", color: "var(--muted)" },
  blue:    { background: "var(--script-soft)", color: "var(--script)" },
  amber:   { background: "var(--stage-soft)", color: "var(--stage)" },
  red:     { background: "var(--danger-soft)", color: "var(--danger)" },
  green:   { background: "var(--success-soft)", color: "var(--success)" },
};

export type BadgeTone = keyof typeof TONES;

export default function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", width: "fit-content",
      minHeight: 22, padding: "3px 8px", borderRadius: 999,
      fontSize: 9, fontWeight: 700, letterSpacing: ".04em",
      ...TONES[tone] ?? TONES.neutral,
    }}>
      {children}
    </span>
  );
}
