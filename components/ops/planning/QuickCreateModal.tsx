"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "@/components/ops/planning.module.css";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";
import type { ProductionEvent } from "@/lib/ops/event-db";
import { dateTimeToIso } from "@/lib/tz";
import BoundedTimePicker from "./BoundedTimePicker";
import type { PlanningDept } from "./types";

export type QuickCreateKind = "event" | "task";

export default function QuickCreateModal({ productionId, date, departments, events, onClose }: {
  productionId: string;
  date: string;
  departments: PlanningDept[];
  events: ProductionEvent[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<QuickCreateKind>("event");
  const [title, setTitle] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("11:00");
  const [eventType, setEventType] = useState("rehearsal");
  const [departmentIds, setDepartmentIds] = useState<Set<string>>(new Set());
  const [allMembers, setAllMembers] = useState(true);
  const [taskEventId, setTaskEventId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid var(--line)",
    borderRadius: 8, background: "var(--paper)", color: "var(--ink)",
    padding: "9px 10px", fontSize: 12,
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    // date 是 CST 日历格子的日期，startTime/endTime 是 CST 时刻——按 CST 解析，
    // 不能交给 new Date() 按浏览器本地时区猜
    const start = dateTimeToIso(date, startTime);
    const end = dateTimeToIso(date, endTime);
    if (end <= start) {
      setError("结束时间必须晚于开始时间");
      setSaving(false);
      return;
    }
    try {
      if (kind === "event") {
        const eventRes = await fetch(`${BASE_PATH}/api/production/${productionId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), eventType, startTime: start, endTime: end }),
        });
        const eventData = await eventRes.json().catch(() => ({}));
        if (!eventRes.ok) throw new Error(eventData.error ?? "事件创建失败");

      } else {
        const taskRes = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            startTime: start,
            endTime: end,
            // 选择器在 task 模式下已是单选，这里取到的就是用户选的那一个
            departmentId: allMembers ? null : [...departmentIds][0] ?? null,
            eventId: taskEventId || null,
            description: "由项目日历快捷创建。",
          }),
        });
        const taskData = await taskRes.json().catch(() => ({}));
        if (!taskRes.ok) throw new Error(taskData.error ?? "任务创建失败");
      }
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${date} 快捷新建`}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(7,29,32,.34)", display: "grid", placeItems: "center", padding: 18 }}
    >
      <form onSubmit={submit} style={{ width: "min(520px, 100%)", maxHeight: "calc(100vh - 36px)", overflowY: "auto", borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface)", boxShadow: "0 22px 70px rgba(7,29,32,.24)", padding: 22 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
          <div>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 10, fontWeight: 700, letterSpacing: ".12em" }}>{date}</p>
            <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 22, fontWeight: 500 }}>快捷新建</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" style={{ marginLeft: "auto", border: 0, background: "transparent", color: "var(--muted)", fontSize: 22, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 14 }}>
          {([['event', '事件', '创建后按实际流程添加日程'], ['task', '任务', '同步进入任务与甘特']] as const).map(([value, label, hint]) => {
            const active = kind === value;
            return (
              <button key={value} type="button" onClick={() => {
                setKind(value);
                // event（多选）切到 task（单选）时把已选收敛成一个，
                // 否则会带着一串选中项进来但只有一个生效
                if (value === "task") setDepartmentIds(current => current.size > 1 ? new Set([[...current][0]]) : current);
              }} style={{ border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`, borderRadius: 9, padding: "10px 11px", background: active ? "var(--ink)" : "var(--paper)", color: active ? "#fff" : "var(--ink)", textAlign: "left", cursor: "pointer" }}>
                <b style={{ display: "block", fontSize: 12 }}>{label}</b>
                <small style={{ display: "block", marginTop: 3, color: active ? "#bdcbc7" : "var(--muted)", fontSize: 9 }}>{hint}</small>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 11, color: "var(--muted)" }}>标题
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={kind === "event" ? "例如：第三场合成排练" : "例如：确认无线麦频点"} style={{ ...fieldStyle, display: "block", marginTop: 5 }} />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <BoundedTimePicker label="开始时间" value={startTime} onChange={setStartTime} />
            <BoundedTimePicker label="结束时间" value={endTime} onChange={setEndTime} />
          </div>
          {kind === "event" && (
            <label style={{ fontSize: 11, color: "var(--muted)" }}>事件类型
              <OverflowSafeSelect value={eventType} onChange={e => setEventType(e.target.value)} style={{ ...fieldStyle, display: "block", marginTop: 5 }}>
                <option value="rehearsal">排练</option><option value="meeting">会议</option><option value="performance">演出</option><option value="custom">其他</option>
              </OverflowSafeSelect>
            </label>
          )}
          {kind === "task" && (
            <label style={{ fontSize: 11, color: "var(--muted)" }}>关联事件（可选）
              <OverflowSafeSelect value={taskEventId} onChange={e => setTaskEventId(e.target.value)} style={{ ...fieldStyle, display: "block", marginTop: 5 }}>
                <option value="">不关联，建立独立任务</option>
                {events.filter(event => event.status !== "cancelled").map(event => (
                  <option key={event.id} value={event.id}>{event.startTime ? `${new Date(event.startTime).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} · ` : ""}{event.title}</option>
                ))}
              </OverflowSafeSelect>
            </label>
          )}
          {kind === "task" && <div>
            <span style={{ display: "block", marginBottom: 5, fontSize: 11, color: "var(--muted)" }}>
              责任部门（任务的责任方唯一，只能选一个）
            </span>
            <div className={styles.multiPicker}>
              <button
                type="button"
                className={`${styles.toggleChip} ${allMembers ? styles.toggleChipActive : ""}`}
                onClick={() => { setAllMembers(true); setDepartmentIds(new Set()); }}
              >
                暂不指定
              </button>
              {departments.map(dept => {
                const active = !allMembers && departmentIds.has(dept.id);
                return (
                  <button
                    key={dept.id}
                    type="button"
                    className={`${styles.toggleChip} ${active ? styles.toggleChipActive : ""}`}
                    onClick={() => {
                      setAllMembers(false);
                      setDepartmentIds(current => {
                        // 任务的责任主体是**单值**（POC 从它推），所以这里是单选：
                        // 让用户多选却只取第一个，等于静默丢弃他的选择
                        if (current.has(dept.id)) { setAllMembers(true); return new Set(); }
                        return new Set([dept.id]);
                      });
                    }}
                  >
                    {dept.name}
                  </button>
                );
              })}
            </div>
          </div>}
        </div>
        {error && <p style={{ margin: "12px 0 0", color: "var(--danger)", fontSize: 11 }}>{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" onClick={onClose} style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", padding: "8px 14px", cursor: "pointer" }}>取消</button>
          <button type="submit" disabled={saving || !title.trim()} style={{ border: "1px solid var(--ink)", borderRadius: 8, background: "var(--ink)", color: "#fff", padding: "8px 14px", cursor: "pointer", opacity: saving || !title.trim() ? .5 : 1 }}>{saving ? "创建中…" : `创建${kind === "event" ? "事件" : "任务"}`}</button>
        </div>
      </form>
    </div>
  );
}
