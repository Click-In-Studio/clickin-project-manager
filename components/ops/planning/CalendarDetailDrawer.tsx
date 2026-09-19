"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "@/components/ops/planning.module.css";
import Badge from "@/components/ui/Badge";
import { BASE_PATH } from "@/lib/base-path";
import { datetimeLocalToIso, isoToDatetimeLocal } from "@/lib/tz";
import type { ProductionEvent } from "@/lib/ops/event-db";
import { TASK_STATUS_LABELS } from "./labels";
import type { PlanningMilestone, PlanningTask } from "./types";

export type CalendarSelection =
  | { kind: "event"; value: ProductionEvent }
  | { kind: "task"; value: PlanningTask }
  | { kind: "milestone"; value: PlanningMilestone };

export default function CalendarDetailDrawer({ productionId, selection, canEdit, onSaved, onClose }: {
  productionId: string;
  selection: CalendarSelection;
  canEdit: boolean;
  onSaved: (selection: CalendarSelection) => void;
  onClose: () => void;
}) {
  const router = useRouter();
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
  const ownStart = isEvent ? selection.value.startTime : isTask ? selection.value.startTime : null;
  const ownEnd = isEvent ? selection.value.endTime : isTask ? selection.value.endTime : null;
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  const [editDescription, setEditDescription] = useState(description ?? "");
  const [editLocation, setEditLocation] = useState(isEvent ? selection.value.location ?? "" : "");
  const [editStart, setEditStart] = useState(isoToDatetimeLocal(ownStart));
  const [editEnd, setEditEnd] = useState(isoToDatetimeLocal(ownEnd));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!isEvent && !isTask) return;
    if (!editTitle.trim()) { setError("请填写名称"); return; }
    if (editStart && editEnd && new Date(editEnd) < new Date(editStart)) {
      setError("结束时间不能早于开始时间"); return;
    }
    setSaving(true);
    setError(null);
    try {
      const endpoint = isEvent ? `events/${value.id}` : `tasks/${value.id}`;
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/${endpoint}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDescription.trim(),
          startTime: editStart ? datetimeLocalToIso(editStart) : null,
          endTime: editEnd ? datetimeLocalToIso(editEnd) : null,
          ...(isEvent ? { location: editLocation.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "保存失败"); return; }
      if (isEvent && data.event) onSaved({ kind: "event", value: data.event });
      if (isTask && data.task) onSaved({ kind: "task", value: { ...selection.value, ...data.task } });
      setEditing(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className={styles.detailDrawer} aria-label={`${title}详情`}>
      <div style={{ minHeight: 94, padding: "20px 22px", borderBottom: "1px solid var(--line)", display: "flex", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 9, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase" }}>
            {isEvent ? "Event" : isTask ? "Task" : "Milestone"}
          </p>
          <h2 style={{ margin: "6px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 22, fontWeight: 500, lineHeight: 1.3 }}>{title}</h2>
        </div>
        <div style={{ display: "flex", gap: 7, flexShrink: 0 }}>
          {canEdit && !editing && (
            <button type="button" onClick={() => setEditing(true)} className={styles.drawerTextButton}>编辑</button>
          )}
          <button type="button" aria-label="关闭详情" onClick={onClose} style={{ width: 31, height: 31, border: "1px solid var(--line)", borderRadius: "50%", background: "transparent", color: "var(--muted)", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
      </div>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 15 }}>
        {editing && (isEvent || isTask) ? (
          <>
            <label className={styles.drawerField}><span>名称</span><input value={editTitle} onChange={e => setEditTitle(e.target.value)} /></label>
            {isEvent && <label className={styles.drawerField}><span>地点</span><input value={editLocation} onChange={e => setEditLocation(e.target.value)} /></label>}
            <div className={styles.drawerTimeGrid}>
              <label className={styles.drawerField}><span>开始时间</span><input type="datetime-local" value={editStart} onChange={e => setEditStart(e.target.value)} /></label>
              <label className={styles.drawerField}><span>结束时间</span><input type="datetime-local" value={editEnd} onChange={e => setEditEnd(e.target.value)} /></label>
            </div>
            {isTask && !ownStart && <small style={{ color: "var(--muted)", marginTop: -8 }}>留空将继续继承绑定日程或事件的时间。</small>}
            <label className={styles.drawerField}><span>说明</span><textarea rows={5} value={editDescription} onChange={e => setEditDescription(e.target.value)} /></label>
            {error && <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: 11 }}>{error}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setEditing(false)} disabled={saving} className={styles.drawerSecondaryButton}>取消</button>
              <button type="button" onClick={save} disabled={saving} className={styles.drawerPrimaryButton}>{saving ? "保存中…" : "保存并同步"}</button>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </aside>
  );
}
