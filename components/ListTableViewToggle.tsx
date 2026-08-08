import styles from "./ListTableViewToggle.module.css";
import { useProductionToolbar } from "./ProductionTopMenu";

type ViewMode = "list" | "table";

type Props = {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
};

export default function ListTableViewToggle({ value, onChange }: Props) {
  const { stage } = useProductionToolbar();
  if (stage >= 5) return null;

  return (
    <div className={styles.viewToggle} data-compact={stage >= 4.2 || undefined}>
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

export function ListTableViewToggleOverflow({ value, onChange }: Pick<Props, "value" | "onChange">) {
  const { closeOverflow } = useProductionToolbar();
  const select = (next: ViewMode) => {
    closeOverflow();
    onChange(next);
  };

  return (
    <div className="border-t border-[var(--line)] py-1">
      <button
        type="button"
        onClick={() => select("list")}
        className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--surface-2)]"
      >
        <span aria-hidden="true">☰</span>
        <span className="min-w-0 flex-1">列表</span>
        {value === "list" && <span className="text-[var(--script)]">✓</span>}
      </button>
      <button
        type="button"
        onClick={() => select("table")}
        className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--surface-2)]"
      >
        <span aria-hidden="true">⊞</span>
        <span className="min-w-0 flex-1">表格</span>
        {value === "table" && <span className="text-[var(--script)]">✓</span>}
      </button>
    </div>
  );
}
