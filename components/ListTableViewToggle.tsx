import styles from "./ListTableViewToggle.module.css";

type ViewMode = "list" | "table";

type Props = {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
};

export default function ListTableViewToggle({ value, onChange }: Props) {
  return (
    <div className={styles.viewToggle}>
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
    </div>
  );
}
