import type { CSSProperties, ReactNode } from "react";

import styles from "@/components/admin/admin-metric-grid.module.css";

export type AdminMetric = {
  value: ReactNode;
  label: string;
  hint: string;
  hintColor?: string;
};

type Props = {
  items: AdminMetric[];
  columns: number;
  responsive?:
    | "overview"
    | "standard"
    | "permission"
    | "compactThree"
    | "seatPriority"
    | "allOrStacked";
};

export default function AdminMetricGrid({
  items,
  columns,
  responsive = "standard",
}: Props) {
  return (
    <div
      className={`${styles.grid} ${styles[responsive]}`}
      style={{ "--admin-metric-columns": columns } as CSSProperties}
      data-admin-metric-grid={responsive}
    >
      {items.map(({ value, label, hint, hintColor }) => (
        <div className={styles.card} key={label}>
          <span className={styles.value}>{value}</span>
          <p className={styles.copy}>
            <b className={styles.label}>{label}</b>
            <small className={styles.hint} style={hintColor ? { color: hintColor } : undefined}>
              {hint}
            </small>
          </p>
        </div>
      ))}
    </div>
  );
}
