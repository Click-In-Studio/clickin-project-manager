"use client";

import React, { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { TECH_STATUS_LABELS } from "./labels";

export default function EventRelationsTab({
  productionId, eventId, tasks, taskIds, milestoneOptions, milestoneIds, canEdit, onSaved,
}: {
  productionId: string;
  eventId: string;
  tasks: { id: string; title: string; status: string; eventId: string | null; eventTitle: string | null }[];
  taskIds: string[];
  milestoneOptions: { id: string; name: string; endDate: string }[];
  milestoneIds: string[];
  canEdit: boolean;
  onSaved: (taskIds: string[], milestoneIds: string[]) => void;
}) {
  const [selectedTasks, setSelectedTasks] = useState(() => new Set(taskIds));
  const [selectedMilestones, setSelectedMilestones] = useState(() => new Set(milestoneIds));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/relations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [...selectedTasks], milestoneIds: [...selectedMilestones] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(data.error ?? "保存关联失败"); return; }
      onSaved(data.taskIds ?? [...selectedTasks], data.milestoneIds ?? [...selectedMilestones]);
      setMessage("关联已保存");
    } catch (err) {
      // 没有 catch 的话 fetch 抛出去，按钮从「保存中…」变回「保存关联」，
      // 用户看不出成没成——而这个面改的是 task 的归属，静默失败代价很大
      setMessage(err instanceof Error ? `保存关联失败：${err.message}` : "保存关联失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  const selectableTasks = tasks.filter(task => !task.eventId || task.eventId === eventId);
  const linkedElsewhere = tasks.filter(task => task.eventId && task.eventId !== eventId);
  const chip = (active: boolean): React.CSSProperties => ({
    border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
    borderRadius: 8, padding: "7px 10px", textAlign: "left", cursor: canEdit ? "pointer" : "default",
    background: active ? "var(--ink)" : "var(--paper)", color: active ? "#fff" : "var(--ink)",
    fontSize: 12, lineHeight: 1.35,
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 12, alignItems: "start" }}>
      <section style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 14, background: "var(--surface)" }}>
        <p style={{ margin: 0, color: "var(--stage)", fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase" }}>Tasks</p>
        <h2 style={{ margin: "3px 0", fontSize: 15, lineHeight: 1.35 }}>该事件需要关注的任务</h2>
        <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 10, lineHeight: 1.45 }}>可关联独立任务；已属于其他事件的任务需先在任务详情中解绑。</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {selectableTasks.map(task => {
            const active = selectedTasks.has(task.id);
            return (
              <button key={task.id} type="button" disabled={!canEdit} aria-pressed={active} onClick={() => toggle(setSelectedTasks, task.id)} style={chip(active)}>
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}><b>{active ? "✓" : "○"}</b><span>{task.title || "（未命名任务）"}</span></span>
                <small style={{ display: "block", margin: "2px 0 0 19px", fontSize: 10, lineHeight: 1.35, opacity: .68 }}>{TECH_STATUS_LABELS[task.status] ?? task.status}{task.eventId === eventId ? " · 已关联本事件" : " · 独立任务"}</small>
              </button>
            );
          })}
          {selectableTasks.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>暂无可关联任务</p>}
        </div>
        {linkedElsewhere.length > 0 && <p style={{ margin: "9px 0 0", color: "var(--muted)", fontSize: 9 }}>另有 {linkedElsewhere.length} 个任务已属于其他事件。</p>}
      </section>

      <section style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 14, background: "var(--surface)" }}>
        <p style={{ margin: 0, color: "var(--stage)", fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase" }}>Milestones</p>
        <h2 style={{ margin: "3px 0", fontSize: 15, lineHeight: 1.35 }}>关联里程碑</h2>
        <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 10, lineHeight: 1.45 }}>事件可同时关联多个里程碑，用于计划页汇总追踪。</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {milestoneOptions.map(milestone => {
            const active = selectedMilestones.has(milestone.id);
            return (
              <button key={milestone.id} type="button" disabled={!canEdit} aria-pressed={active} onClick={() => toggle(setSelectedMilestones, milestone.id)} style={chip(active)}>
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}><b>{active ? "◆" : "◇"}</b><span>{milestone.name}</span></span>
                <small style={{ display: "block", margin: "2px 0 0 19px", fontSize: 10, lineHeight: 1.35, opacity: .68 }}>目标日期 {milestone.endDate.slice(0, 10)}</small>
              </button>
            );
          })}
          {milestoneOptions.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>项目尚未创建里程碑</p>}
        </div>
      </section>

      <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12 }}>
        {message && <span role="status" style={{ marginRight: "auto", color: message === "关联已保存" ? "var(--success)" : "var(--danger)", fontSize: 12 }}>{message}</span>}
        <Link href={`/production/${productionId}/tasks?event=${eventId}`} style={{ color: "var(--stage)", fontSize: 11, textDecoration: "none" }}>查看关联任务 →</Link>
        {canEdit && <button type="button" disabled={saving} onClick={save} style={{ border: 0, borderRadius: 8, padding: "9px 16px", background: "var(--ink)", color: "#fff", fontWeight: 700, cursor: saving ? "wait" : "pointer", opacity: saving ? .6 : 1 }}>{saving ? "保存中…" : "保存关联"}</button>}
      </div>
    </div>
  );
}
