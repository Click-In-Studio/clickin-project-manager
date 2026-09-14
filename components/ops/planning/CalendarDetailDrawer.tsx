"use client";

import Link from "next/link";
import styles from "@/components/ops/planning.module.css";
import Badge from "@/components/ui/Badge";
import type { ProductionEvent } from "@/lib/ops/event-db";
import { TASK_STATUS_LABELS } from "./labels";
import type { PlanningMilestone, PlanningTask } from "./types";

export type CalendarSelection =
  | { kind: "event"; value: ProductionEvent }
  | { kind: "task"; value: PlanningTask }
  | { kind: "milestone"; value: PlanningMilestone };

export default function CalendarDetailDrawer({ productionId, selection, onClose }: {
  productionId: string;
  selection: CalendarSelection;
  onClose: () => void;
}) {
  const isEvent = selection.kind === "event";
  const isTask = selection.kind === "task";
  const value = selection.value;
  const href = isEvent
    ? `/production/${productionId}/events/${value.id}`
    : isTask ? `/production/${productionId}/tasks/${value.id}` : null;
  const title = isEvent ? selection.value.title : isTask ? selection.value.title : selection.value.name;
  const start = isEvent ? selection.value.startTime : isTask ? selection.value.effectiveStartTime : selection.value.endDate;
  const end = isEvent ? selection.value.endTime : isTask ? selection.value.effectiveEndTime : null;
  const description = isEvent ? selection.value.description : isTask ? selection.value.description : "项目里程碑";

  return (
    <aside className={styles.detailDrawer} aria-label={`${title}详情`}>
      <div style={{ minHeight: 94, padding: "20px 22px", borderBottom: "1px solid var(--line)", display: "flex", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 9, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase" }}>
            {isEvent ? "Event" : isTask ? "Task" : "Milestone"}
          </p>
          <h2 style={{ margin: "6px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 22, fontWeight: 500, lineHeight: 1.3 }}>{title}</h2>
        </div>
        <button type="button" aria-label="关闭详情" onClick={onClose} style={{ width: 31, height: 31, border: "1px solid var(--line)", borderRadius: "50%", background: "transparent", color: "var(--muted)", fontSize: 18, cursor: "pointer" }}>×</button>
      </div>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 15 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {isEvent && <Badge tone={selection.value.status === "completed" ? "green" : selection.value.status === "cancelled" ? "red" : "blue"}>{selection.value.status === "published" ? "已发布" : selection.value.status === "completed" ? "已完成" : selection.value.status === "cancelled" ? "已取消" : "草稿"}</Badge>}
          {isTask && <Badge tone={selection.value.status === "done" ? "green" : selection.value.status === "in_progress" ? "blue" : "neutral"}>{TASK_STATUS_LABELS[selection.value.status] ?? selection.value.status}</Badge>}
          {isTask && selection.value.departmentName && <Badge>{selection.value.departmentName}</Badge>}
        </div>
        {start && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
            <b style={{ color: "var(--ink)" }}>时间</b><br />
            {new Date(start).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: isEvent || isTask ? "2-digit" : undefined, minute: isEvent || isTask ? "2-digit" : undefined, hour12: false })}
            {end ? ` — ${new Date(end).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
          </p>
        )}
        {isEvent && selection.value.location && <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}><b style={{ color: "var(--ink)" }}>地点</b><br />{selection.value.location}</p>}
        {isTask && selection.value.eventTitle && <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}><b style={{ color: "var(--ink)" }}>关联事件</b><br />{selection.value.eventTitle}</p>}
        {description && <p style={{ margin: 0, paddingTop: 14, borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--ink)", lineHeight: 1.7 }}>{description}</p>}
        {href && (
          <Link href={href} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 4, border: "1px solid var(--ink)", borderRadius: 8, padding: "10px 14px", color: "#fff", background: "var(--ink)", textDecoration: "none", fontSize: 12, fontWeight: 700 }}>
            前往{isEvent ? "事件" : "任务"}详情 →
          </Link>
        )}
      </div>
    </aside>
  );
}
