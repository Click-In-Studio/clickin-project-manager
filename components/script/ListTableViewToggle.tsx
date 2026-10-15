import styles from "./ListTableViewToggle.module.css";
import type { ListTableViewMode } from "./use-list-table-view-preference";

type Props = {
  value: ListTableViewMode;
  onChange: (value: ListTableViewMode) => void;
};

export default function ListTableViewToggle({ value, onChange }: Props) {

  return (
    <div className={styles.viewToggle}>
      <button
        type="button"
        aria-label="表格"
        title="表格"
        aria-pressed={value === "table"}
        onClick={() => onChange("table")}
      >
        <span className={styles.icon} aria-hidden="true">⊞</span>
        <span className={styles.label}>表格</span>
      </button>
      <button
        type="button"
        aria-label="列表"
        title="列表"
        aria-pressed={value === "list"}
        onClick={() => onChange("list")}
      >
        <span className={styles.icon} aria-hidden="true">☰</span>
        <span className={styles.label}>列表</span>
      </button>
    </div>
  );
}
