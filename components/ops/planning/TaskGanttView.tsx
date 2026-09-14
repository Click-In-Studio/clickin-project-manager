"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import { todayCSTStr } from "@/lib/tz";
import { DAY_MS, floorToMonday, cstAxisDateFromIso, dateOnlyAxisMs, addDaysIso } from "./date";
import { TASK_STATUS_LABELS } from "./labels";
import { phaseTone, phaseRangeLabel } from "./phase";
import { readPref, writePref } from "./prefs";
import type { PlanningTask, Props } from "./types";

type GanttScale = "day" | "month" | "quarter" | "year";
type GanttDragMode = "move" | "resize-start" | "resize-end";

/** 状态→条形配色（原型 milestoneBar* 色板；受阻优先于状态） */
function barTone(t: PlanningTask): { bg: string; color: string } {
  if (t.isBlocked && t.status !== "done") return { bg: "#f5dfd8", color: "#8a4434" };
  if (t.status === "done") return { bg: "#e8e6f7", color: "#535078" };
  if (t.status === "in_progress") return { bg: "var(--script)", color: "#fff" };
  return { bg: "#d2f0e8", color: "#28594f" };  // pending / awaiting
}

export default function TaskGanttView({ productionId, tasks, milestones, phases }: Props) {
  const router = useRouter();
  const [scale, setScale] = useState<GanttScale>("month");
  const [scaleRestored, setScaleRestored] = useState(false);
  const [localTasks, setLocalTasks] = useState<PlanningTask[]>(tasks);
  useEffect(() => { setLocalTasks(tasks); }, [tasks]);

  useEffect(() => {
    const saved = readPref(`planning-gantt-scale:${productionId}`);
    if (saved === "day" || saved === "month" || saved === "quarter" || saved === "year") setScale(saved);
    setScaleRestored(true);
  }, [productionId]);

  useEffect(() => {
    if (!scaleRestored) return;
    writePref(`planning-gantt-scale:${productionId}`, scale);
  }, [productionId, scale, scaleRestored]);

  const timedTasks = useMemo(
    () => localTasks
      .filter(t => t.effectiveStartTime)
      .sort((a, b) => (a.effectiveStartTime! < b.effectiveStartTime! ? -1 : 1)),
    [localTasks],
  );

  // 轴锚点：最早内容（任务∪阶段）与今天取早者，按粒度取整；跨度固定。
  // 开放尾阶段只贡献 start，不拉长轴。
  const { axisStart, axisDays, labels } = useMemo(() => {
    const [todayYear, todayMonth, todayDay] = todayCSTStr().split("-").map(Number);
    const today = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay));
    const candidates: Date[] = [today];
    if (timedTasks[0]?.effectiveStartTime) candidates.push(cstAxisDateFromIso(timedTasks[0].effectiveStartTime));
    for (const p of phases) candidates.push(new Date(dateOnlyAxisMs(p.startDate)));
    const base = candidates.reduce((min, d) => (d < min ? d : min), today);
    if (scale === "day") {
      const start = floorToMonday(base);
      return {
        axisStart: start, axisDays: 42,
        labels: Array.from({ length: 6 }, (_, i) => {
          const d = new Date(start); d.setUTCDate(d.getUTCDate() + i * 7);
          return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
        }),
      };
    }
    if (scale === "month") {
      const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 6, 1));
      return {
        axisStart: start, axisDays: Math.round((end.getTime() - start.getTime()) / DAY_MS),
        labels: Array.from({ length: 6 }, (_, i) => {
          const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
          return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        }),
      };
    }
    if (scale === "quarter") {
      const start = new Date(Date.UTC(base.getUTCFullYear(), Math.floor(base.getUTCMonth() / 3) * 3, 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 18, 1));
      return {
        axisStart: start, axisDays: Math.round((end.getTime() - start.getTime()) / DAY_MS),
        labels: Array.from({ length: 6 }, (_, i) => {
          const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i * 3, 1));
          return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        }),
      };
    }
    const start = new Date(Date.UTC(base.getUTCFullYear(), 0, 1));
    return {
      axisStart: start, axisDays: 365,
      labels: Array.from({ length: 12 }, (_, i) => `${i + 1} 月`),
    };
  }, [scale, timedTasks, phases]);

  const axisEndMs = axisStart.getTime() + axisDays * DAY_MS;
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms - axisStart.getTime()) / (axisEndMs - axisStart.getTime()) * 100));

  const visibleMilestones = milestones.filter(m => {
    const ms = Date.parse(`${m.endDate.slice(0, 10)}T12:00:00Z`);
    return ms >= axisStart.getTime() && ms < axisEndMs;
  });

  // ── 拖拽改期（写回自身 start/end；继承时间被拖动即物化为自身时间）──────────
  const dragRef = useRef<{
    id: string; mode: GanttDragMode; startX: number; width: number;
    origStart: string; origEnd: string; moved: boolean;
    snapshot: PlanningTask[];
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [saving, setSaving] = useState<string | null>(null);

  function startDrag(e: React.PointerEvent<HTMLElement>, t: PlanningTask, mode: GanttDragMode) {
    const timeline = e.currentTarget.closest("[data-gantt-timeline]") as HTMLElement | null;
    if (!timeline) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    suppressClickRef.current = false;
    dragRef.current = {
      id: t.id, mode, startX: e.clientX, width: timeline.getBoundingClientRect().width,
      origStart: t.effectiveStartTime!, origEnd: t.effectiveEndTime ?? t.effectiveStartTime!,
      moved: false, snapshot: localTasks,
    };
  }

  function moveDrag(e: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) > 3) {
      drag.moved = true;
      suppressClickRef.current = true;
    }
    const deltaDays = Math.round((e.clientX - drag.startX) / drag.width * axisDays);
    setLocalTasks(cur => cur.map(t => {
      if (t.id !== drag.id) return t;
      let ns = drag.origStart, ne = drag.origEnd;
      if (drag.mode === "move") { ns = addDaysIso(drag.origStart, deltaDays); ne = addDaysIso(drag.origEnd, deltaDays); }
      else if (drag.mode === "resize-start") {
        ns = addDaysIso(drag.origStart, deltaDays);
        if (ns > ne) ns = ne;
      } else {
        ne = addDaysIso(drag.origEnd, deltaDays);
        if (ne < ns) ne = ns;
      }
      return { ...t, startTime: ns, endTime: ne, effectiveStartTime: ns, effectiveEndTime: ne };
    }));
  }

  async function finishDrag(e: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !drag.moved) return;
    // 按最终指针位置重算终值（与 moveDrag 同一公式，避免读异步 state）
    const deltaDays = Math.round((e.clientX - drag.startX) / drag.width * axisDays);
    let ns = drag.origStart, ne = drag.origEnd;
    if (drag.mode === "move") { ns = addDaysIso(drag.origStart, deltaDays); ne = addDaysIso(drag.origEnd, deltaDays); }
    else if (drag.mode === "resize-start") { ns = addDaysIso(drag.origStart, deltaDays); if (ns > ne) ns = ne; }
    else { ne = addDaysIso(drag.origEnd, deltaDays); if (ne < ns) ne = ns; }
    if (ns === drag.origStart && ne === drag.origEnd) return;
    setSaving(drag.id);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${drag.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startTime: ns, endTime: ne }),
      });
      if (!res.ok) {
        setLocalTasks(drag.snapshot);
        const data = await res.json().catch(() => null);
        alert(data?.error ?? "改期失败（可能无编辑权限）");
      }
    } catch {
      setLocalTasks(drag.snapshot);
      alert("网络错误，改期未保存");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
            {labels[0]} — {labels[labels.length - 1]}
          </p>
          <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>
            任务甘特图
          </h2>
          <small style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            时间为有效起止（自身 → 绑定日程 → 事件）；拖动条形改期，拖动即固化为任务自身时间。
          </small>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexShrink: 0, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 2, border: "1px solid var(--line)", borderRadius: 8, padding: 2 }} aria-label="时间轴粒度">
            {([["day", "日"], ["month", "月"], ["quarter", "季"], ["year", "年"]] as const).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={scale === value}
                onClick={() => setScale(value)}
                style={{
                  border: 0, borderRadius: 6, padding: "3px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer",
                  background: scale === value ? "var(--ink)" : "transparent",
                  color: scale === value ? "#fff" : "var(--muted)",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, color: "var(--muted)", fontSize: 9 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: 2, background: "var(--script)" }} />进行中</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: 2, background: "#d2f0e8", border: "1px solid #9ccfc0" }} />待处理</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: 2, background: "#f5dfd8", border: "1px solid #d8a893" }} />受阻</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: 2, background: "#e8e6f7", border: "1px solid #b9b5dd" }} />完成</span>
          </div>
        </div>
      </div>

      {timedTasks.length === 0 && phases.length === 0 ? (
        <p style={{ margin: 0, padding: "36px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
          暂无阶段或带时间的任务。在任务上设置起止时间，或绑定带时间的日程/事件后此处生成时间条。
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 640 }}>
            {/* 轴表头 + 里程碑标记条 */}
            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr" }}>
              <span />
              <div style={{ position: "relative", display: "grid", gridTemplateColumns: `repeat(${labels.length}, 1fr)`, minHeight: 34 }}>
                {labels.map(l => (
                  <b key={l} style={{ fontSize: 9, fontWeight: 400, color: "var(--muted)", textAlign: "left", paddingTop: 4, borderLeft: "1px solid var(--line)", paddingLeft: 5 }}>{l}</b>
                ))}
                {visibleMilestones.map(m => {
                  const left = pct(Date.parse(`${m.endDate.slice(0, 10)}T12:00:00Z`));
                  return (
                    <strong
                      key={m.id}
                      title={`${m.name} · ${m.endDate.slice(0, 10)}`}
                      style={{ position: "absolute", left: `${left}%`, bottom: 0, transform: "translateX(-50%)", fontSize: 10, color: "var(--ink)", cursor: "default" }}
                    >
                      ◆
                    </strong>
                  );
                })}
              </div>
            </div>
            {/* 阶段背景带行（在任务行上方；开放尾渐隐到轴右缘） */}
            {phases.map((p, pi) => {
              const tone = phaseTone(pi);
              const sMs = dateOnlyAxisMs(p.startDate);
              const eMs = p.endDate ? dateOnlyAxisMs(p.endDate, true) : null;
              const outOfAxis = sMs >= axisEndMs || (eMs !== null && eMs < axisStart.getTime());
              const left = pct(sMs);
              const right = eMs === null ? 100 : pct(eMs);
              const width = Math.max(right - left, 1);
              const open = eMs === null;
              const label = p.deptName ? `${p.name}（${p.deptName}）` : p.name;
              return (
                <div key={p.id} style={{ display: "grid", gridTemplateColumns: "200px 1fr", minHeight: 34, borderTop: "1px solid var(--line)" }}>
                  <div style={{ padding: "6px 10px 6px 0", minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
                    <b style={{ fontSize: 11, color: tone.solid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </b>
                    <small style={{ fontSize: 9, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[p.deptName ?? "全项目", `阶段`].join(" · ")}
                    </small>
                  </div>
                  <div style={{
                    position: "relative", minHeight: 34,
                    backgroundImage: "linear-gradient(to right, var(--line) 1px, transparent 1px)",
                    backgroundSize: `${100 / labels.length}% 100%`,
                  }}>
                    {!outOfAxis && (
                      <div
                        title={`${label} · ${phaseRangeLabel(p)}`}
                        style={{
                          position: "absolute", top: 7, height: 20, left: `${left}%`, width: `${width}%`,
                          borderRadius: 5,
                          background: open
                            ? `linear-gradient(to right, ${tone.bg} 65%, transparent)`
                            : tone.bg,
                          borderLeft: `2px solid ${tone.solid}`,
                          borderRight: open ? "none" : `2px solid ${tone.solid}`,
                          color: tone.solid, display: "flex", alignItems: "center",
                          padding: "0 6px", fontSize: 8, fontWeight: 700,
                          overflow: "hidden", whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                        {open && <em style={{ marginLeft: 6, fontStyle: "normal", fontSize: 7, opacity: .7 }}>进行中</em>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* 任务行 */}
            {timedTasks.map(t => {
              const startMs = cstAxisDateFromIso(t.effectiveStartTime!).getTime();
              const endMs = Math.max(startMs + DAY_MS * 0.5, cstAxisDateFromIso(t.effectiveEndTime ?? t.effectiveStartTime!).getTime());
              const left = pct(startMs);
              const width = Math.max(pct(endMs) - left, 1.5);
              const tone = barTone(t);
              const dur = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
              const context = t.eventTitle ?? t.departmentName;
              return (
                <div key={t.id} style={{ display: "grid", gridTemplateColumns: "200px 1fr", minHeight: 48, borderTop: "1px solid var(--line)" }}>
                  <button
                    onClick={() => router.push(`/production/${productionId}/tasks/${t.id}`)}
                    style={{ border: 0, background: "transparent", padding: "6px 10px 6px 0", textAlign: "left", cursor: "pointer", minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}
                  >
                    <b style={{ fontSize: 11, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.isBlocked && t.status !== "done" && <span title="被前置任务阻塞" style={{ color: "#8a4434" }}>⛔ </span>}
                      {t.title || "（未命名任务）"}
                    </b>
                    <small style={{ fontSize: 9, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[context, TASK_STATUS_LABELS[t.status] ?? t.status].filter(Boolean).join(" · ")}
                    </small>
                  </button>
                  <div
                    data-gantt-timeline
                    style={{
                      position: "relative", minHeight: 48,
                      backgroundImage: "linear-gradient(to right, var(--line) 1px, transparent 1px)",
                      backgroundSize: `${100 / labels.length}% 100%`,
                    }}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      title={`${t.title} · ${dur} 天${t.startTime ? "" : "（时间继承自绑定日程/事件，拖动后固化）"}`}
                      onClick={() => { if (!suppressClickRef.current) router.push(`/production/${productionId}/tasks/${t.id}`); }}
                      onPointerDown={e => startDrag(e, t, "move")}
                      onPointerMove={moveDrag}
                      onPointerUp={finishDrag}
                      style={{
                        position: "absolute", top: 13, height: 22, left: `${left}%`, width: `${width}%`,
                        borderRadius: 6, background: tone.bg, color: tone.color,
                        border: t.startTime ? "none" : "1px dashed rgba(24,42,42,.35)",
                        display: "flex", alignItems: "center", gap: 6, padding: "0 7px",
                        fontSize: 8, cursor: "grab", overflow: "hidden", whiteSpace: "nowrap",
                        boxShadow: "0 2px 6px rgba(24,42,42,.10)",
                        opacity: saving === t.id ? 0.6 : 1,
                        touchAction: "none",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
                      <em style={{ marginLeft: "auto", fontStyle: "normal", fontSize: 7 }}>{dur}天</em>
                      {/* 缩放把手 */}
                      <i
                        onPointerDown={e => startDrag(e, t, "resize-start")}
                        onPointerMove={moveDrag}
                        onPointerUp={finishDrag}
                        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 7, cursor: "ew-resize" }}
                      />
                      <i
                        onPointerDown={e => startDrag(e, t, "resize-end")}
                        onPointerMove={moveDrag}
                        onPointerUp={finishDrag}
                        style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 7, cursor: "ew-resize" }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
