import styles from "./home.module.css";

export default function MilestoneMetricValue({
  days,
  emptyLabel,
}: {
  days: number | null;
  emptyLabel: string;
}) {
  if (days === null) return <strong>{emptyLabel}</strong>;
  if (days === 0) return <strong>今天</strong>;

  return (
    <strong className={styles.progressMetricValue}>
      {days < 0 && <span>已过</span>}
      <span>{Math.abs(days)}</span>
      <span className={styles.progressMetricUnit}>天</span>
    </strong>
  );
}
