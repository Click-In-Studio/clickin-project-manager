"use client";

import { useState, useMemo, Fragment, type CSSProperties } from "react";
import Link from "next/link";
import type React from "react";
import { BASE_PATH } from "@/lib/base-path";
import PageHeader, { PRIMARY_BTN } from "@/components/PageHeader";
import Badge, { type BadgeTone } from "@/components/Badge";
import type { ProductionEvent, EventDepartment } from "@/lib/event-db";
import { fmtDateTimeSmart, datetimeLocalToIso, dateTimeToIso } from "@/lib/tz";

// ─── Shared constants ────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练",
  performance: "演出",
  meeting: "会议",
  custom: "其他",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  completed: "已完成",
  cancelled: "已取消",
};

const STATUS_COLORS: Record<string, { background: string; color: string }> = {
  draft:     { background: "var(--paper)",  color: "var(--muted)" },
  published: { background: "#eff6ff",       color: "#2563eb" },
  completed: { background: "#f0fdf4",       color: "#16a34a" },
  cancelled: { background: "#fff1f2",       color: "#e11d48" },
};

// ─── List view: EventCard ────────────────────────────────────────────────────

function EventCard({
  event, productionId, role, canViewFull, taskCount = 0, first = false, onFollow, onUnfollow,
}: {
  event: ProductionEvent;
  productionId: string;
  role: "participant" | "follower" | null;
  canViewFull: boolean;
  taskCount?: number;
  first?: boolean;
  onFollow: (eventId: string) => void;
  onUnfollow: (eventId: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const method = role === "follower" ? "DELETE" : "POST";
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/follow`, { method });
      if (res.ok) {
        if (method === "POST") onFollow(event.id);
        else onUnfollow(event.id);
      }
    } finally {
      setBusy(false);
    }
  }

  const detailHref = canViewFull
    ? `/production/${productionId}/events/${event.id}`
    : `/production/${productionId}/events/${event.id}/view`;
  const typeTone: BadgeTone =
    event.eventType === "performance" ? "red" :
    event.eventType === "rehearsal" ? "blue" : "neutral";
  const statusText = STATUS_LABELS[event.status] ?? event.status;

  const go = (href: string) => { window.location.href = `${BASE_PATH}${href}`; };

  // 原型 eventList article：grid 58px / 1fr / auto
  return (
    <article style={{
      display: "grid", gridTemplateColumns: "58px 1fr auto", gap: 16,
      padding: "18px 0", borderTop: first ? 0 : "1px solid var(--line)",
    }}>
      {/* 日期盒（54×59 边框盒 + serif 22px） */}
      <time style={{
        width: 54, height: 59, border: "1px solid var(--line)", borderRadius: 9,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      }}>
        {event.startTime ? (
          <>
            <b style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 500, color: "var(--ink)" }}>
              {new Date(event.startTime).getDate()}
            </b>
            <small style={{ color: "var(--muted)", fontSize: 9 }}>
              {new Date(event.startTime).getMonth() + 1} 月
            </small>
          </>
        ) : (
          <small style={{ color: "var(--muted)", fontSize: 9 }}>待定</small>
        )}
      </time>

      {/* 中列：Badge 行 → serif 标题 → 时间地点 → inlineActions */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <Badge tone={typeTone}>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</Badge>
          {event.status === "draft" && <Badge>草稿</Badge>}
        </div>
        <h3 style={{ margin: "8px 0 3px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, lineHeight: 1.3 }}>
          <Link href={detailHref} style={{ color: "inherit", textDecoration: "none" }}>
            {event.title}
          </Link>
        </h3>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 10 }}>
          {[event.startTime && fmtDateTimeSmart(event.startTime), event.location].filter(Boolean).join(" · ")}
        </p>
        {/* inlineActions（原型：paper 底 script 色边框小按钮） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button onClick={() => go(detailHref)} style={INLINE_ACTION_BTN}>
            事件详情 <span style={{ marginLeft: 3 }}>→</span>
          </button>
          {canViewFull && (
            <button onClick={() => go(`/production/${productionId}/events/${event.id}/callsheet`)} style={INLINE_ACTION_BTN}>
              执行流程 <span style={{ marginLeft: 3 }}>→</span>
            </button>
          )}
          {taskCount > 0 && (
            <button onClick={() => go(`/production/${productionId}/tasks?event=${event.id}`)} style={INLINE_ACTION_BTN}>
              {taskCount} 个任务 <span style={{ marginLeft: 3 }}>→</span>
            </button>
          )}
        </div>
      </div>

      {/* 右列：eventStatus 丸 + 关注 */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
        <span style={{
          width: "fit-content", padding: "5px 8px", borderRadius: 999,
          background: "var(--stage-soft)", color: "var(--stage)", fontSize: 9, fontWeight: 700,
        }}>
          {statusText}
        </span>
        {role === "participant" ? (
          <span style={{ fontSize: 10, color: "var(--muted)" }}>已参与</span>
        ) : (
          <button
            onClick={toggle}
            disabled={busy}
            style={{
              fontSize: 10, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--line)", cursor: "pointer",
              opacity: busy ? 0.5 : 1, transition: "all .1s",
              background: role === "follower" ? "var(--script-soft)" : "var(--paper)",
              color: role === "follower" ? "var(--script)" : "var(--muted)",
            }}
          >
            {role === "follower" ? "已关注" : "关注"}
          </button>
        )}
      </div>
    </article>
  );
}

const INLINE_ACTION_BTN: CSSProperties = {
  minHeight: 28, padding: "5px 8px", border: "1px solid var(--line)", borderRadius: 7,
  background: "var(--paper)", color: "var(--script)", fontSize: 9, cursor: "pointer",
};

// ─── Create event modal ──────────────────────────────────────────────────────

function CreateEventModal({
  productionId, departments, onClose, onCreated,
}: {
  productionId: string;
  departments: EventDepartment[];
  onClose: () => void;
  onCreated: (ev: ProductionEvent) => void;
}) {
  const [title,         setTitle]         = useState("");
  const [eventType,     setEventType]     = useState("rehearsal");
  const [location,      setLocation]      = useState("");
  const [singleDay,     setSingleDay]     = useState(false);
  const [singleDate,    setSingleDate]    = useState("");
  const [startTime,     setStartTime]     = useState("");
  const [endTime,       setEndTime]       = useState("");
  const [description,   setDescription]   = useState("");
  const [notifyDeptIds, setNotifyDeptIds] = useState<string[]>([]);
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError("请输入标题"); return; }
    const resolvedStart = singleDay
      ? (singleDate ? dateTimeToIso(singleDate, "00:00") : null)
      : (startTime  ? datetimeLocalToIso(startTime) : null);
    const resolvedEnd = singleDay
      ? (singleDate ? dateTimeToIso(singleDate, "23:59") : null)
      : (endTime    ? datetimeLocalToIso(endTime) : null);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          eventType,
          location: location.trim(),
          startTime: resolvedStart,
          endTime: resolvedEnd,
          description: description.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "创建失败"); return; }
      if (notifyDeptIds.length > 0 && data.event?.id) {
        await fetch(`${BASE_PATH}/api/production/${productionId}/events/${data.event.id}/awaiting-reqs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ departmentIds: notifyDeptIds }),
        });
      }
      onCreated(data.event);
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", borderRadius: 8, border: "1px solid var(--line)",
    background: "var(--paper)", padding: "7px 10px", fontSize: 13,
    color: "var(--ink)", outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    display: "block", fontSize: 11, fontWeight: 600,
    color: "var(--muted)", marginBottom: 4, letterSpacing: ".02em",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--surface)", borderRadius: 16, border: "1px solid var(--line)", width: "100%", maxWidth: 440, padding: 24, boxShadow: "0 8px 32px rgba(0,0,0,.12)", maxHeight: "90vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>新建事件</p>
          <button onClick={onClose} style={{ fontSize: 18, color: "var(--muted)", background: "none", border: 0, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={labelStyle}>标题 *</label>
            <input value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} placeholder="事件标题" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>类型</label>
              <select value={eventType} onChange={e => setEventType(e.target.value)} style={inputStyle}>
                <option value="rehearsal">排练</option>
                <option value="performance">演出</option>
                <option value="meeting">会议</option>
                <option value="custom">其他</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>地点</label>
              <input value={location} onChange={e => setLocation(e.target.value)} style={inputStyle} placeholder="排练厅…" />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", fontSize: 12, color: "var(--ink)" }}>
            <input type="checkbox" checked={singleDay} onChange={e => setSingleDay(e.target.checked)} />
            单日事件
          </label>
          {singleDay ? (
            <div>
              <label style={labelStyle}>日期</label>
              <input type="date" value={singleDate} onChange={e => setSingleDate(e.target.value)} style={inputStyle} />
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>开始时间</label>
                <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>结束时间</label>
                <input type="datetime-local" value={endTime} onChange={e => setEndTime(e.target.value)} style={inputStyle} />
              </div>
            </div>
          )}
          <div>
            <label style={labelStyle}>备注</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              style={{ ...inputStyle, resize: "none" }} placeholder="可选…" />
          </div>
          {departments.length > 0 && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)" }}>通知部门（创建待确认需求）</span>
                <button type="button"
                  onClick={() => setNotifyDeptIds(
                    notifyDeptIds.length === departments.length ? [] : departments.map(d => d.id)
                  )}
                  style={{ fontSize: 11, color: "var(--muted)", background: "none", border: 0, cursor: "pointer" }}
                >
                  {notifyDeptIds.length === departments.length ? "取消全选" : "全选"}
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {departments.map(d => (
                  <button key={d.id} type="button"
                    onClick={() => setNotifyDeptIds(prev =>
                      prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id]
                    )}
                    style={{
                      borderRadius: 20, padding: "4px 12px", fontSize: 12, border: "1px solid var(--line)",
                      cursor: "pointer", transition: "all .1s",
                      background: notifyDeptIds.includes(d.id) ? "var(--ink)" : "var(--surface)",
                      color: notifyDeptIds.includes(d.id) ? "#fff" : "var(--muted)",
                    }}
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <p style={{ fontSize: 12, color: "#dc2626" }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
            <button type="button" onClick={onClose}
              style={{ padding: "7px 16px", fontSize: 13, color: "var(--muted)", background: "none", border: 0, cursor: "pointer" }}>
              取消
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: "7px 20px", borderRadius: 8, background: "var(--ink)", color: "#fff", fontSize: 13, fontWeight: 600, border: 0, cursor: "pointer", opacity: saving ? 0.5 : 1 }}>
              {saving ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

type Props = {
  productionId: string;
  productionName: string;
  initialEvents: ProductionEvent[];
  canCreate: boolean;
  canViewFull: boolean;
  myParticipations: { eventId: string; role: "participant" | "follower" }[];
  currentUserId: string;
  departments: EventDepartment[];
  taskCounts?: Record<string, number>;
};

export default function EventsClient({
  productionId, productionName, initialEvents, canCreate, canViewFull,
  myParticipations, departments, taskCounts = {},
}: Props) {
  const [events,      setEvents]      = useState(initialEvents);
  const [showCreate,  setShowCreate]  = useState(false);
  const [justCreated, setJustCreated] = useState<ProductionEvent | null>(null);
  const [roles,      setRoles]      = useState<Map<string, "participant" | "follower">>(() =>
    new Map(myParticipations.map(p => [p.eventId, p.role]))
  );

  const now      = new Date();
  const upcoming = events.filter(e => !e.startTime || new Date(e.startTime) >= now);
  const past     = events.filter(e => e.startTime && new Date(e.startTime) < now);

  function handleCreated(ev: ProductionEvent) {
    setEvents(prev => [ev, ...prev].sort((a, b) => {
      if (!a.startTime && !b.startTime) return 0;
      if (!a.startTime) return 1;
      if (!b.startTime) return -1;
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    }));
    setShowCreate(false);
    setJustCreated(ev);
  }

  function handleFollow(eventId: string) {
    setRoles(prev => new Map(prev).set(eventId, "follower"));
  }
  function handleUnfollow(eventId: string) {
    setRoles(prev => { const m = new Map(prev); m.delete(eventId); return m; });
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Page header（v3 统一页头） */}
      <PageHeader
        eyebrow="Events"
        title="事件"
        side="stage"
        actions={canCreate && (
          <button onClick={() => setShowCreate(true)} style={PRIMARY_BTN}>
            ＋ 新建事件
          </button>
        )}
      />

      {/* Content（日历模式已移除——项目日历归"计划与日程"面板） */}
      {(
        <>
          {/* 三步流程说明条（原型 flowExplainer：三卡 + 箭头——设计语言保留；
              高度对齐各页摘要卡 92px 体系） */}
          {canCreate && (
            <section style={{
              display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr",
              alignItems: "center", gap: 13, marginBottom: 18,
            }}>
              {[["1", "定义事件", "类型、时间、地点、人员"],
                ["2", "确认任务", "负责人、截止、通知对象"],
                ["3", "发布与追踪", "站内通知、确认、执行"]].map(([n, t, s], i) => (
                <Fragment key={n}>
                  {i > 0 && <i style={{ fontStyle: "normal", color: "var(--muted)" }}>→</i>}
                  <div style={{
                    minHeight: 92, padding: "17px 19px", border: "1px solid var(--line)", borderRadius: 14,
                    background: "var(--surface)", display: "grid",
                    gridTemplateColumns: "32px 1fr", gridTemplateRows: "1fr 1fr",
                    alignItems: "center", columnGap: 13,
                  }}>
                    <span style={{
                      width: 32, height: 32, borderRadius: "50%", gridRow: "1 / 3",
                      display: "grid", placeItems: "center",
                      background: "var(--ink)", color: "#fff", fontSize: 10,
                    }}>{n}</span>
                    <b style={{ fontSize: 11, alignSelf: "end", color: "var(--ink)" }}>{t}</b>
                    <small style={{ color: "var(--muted)", fontSize: 9, alignSelf: "start", marginTop: 3 }}>{s}</small>
                  </div>
                </Fragment>
              ))}
            </section>
          )}

          {/* 发布成功 banner（原型 successBanner） */}
          {justCreated && (
            <section role="status" style={{
              display: "flex", alignItems: "center", gap: 13,
              background: "var(--success-soft)", border: "1px solid #c8dfd2", borderRadius: 12,
              padding: "14px 18px", marginBottom: 18,
            }}>
              <span style={{
                width: 32, height: 32, borderRadius: "50%", background: "var(--success)",
                color: "#fff", display: "grid", placeItems: "center", flexShrink: 0,
              }}>✓</span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <b style={{ fontSize: 12, color: "var(--ink)" }}>「{justCreated.title}」已创建</b>
                <small style={{ color: "var(--muted)", fontSize: 10, marginTop: 3 }}>
                  可继续补充日程条目、任务与参与人员。
                </small>
              </div>
              <Link
                href={`/production/${productionId}/events/${justCreated.id}`}
                style={{ marginLeft: "auto", border: 0, background: "transparent", color: "var(--success)", fontWeight: 700, fontSize: 12, textDecoration: "none", whiteSpace: "nowrap" }}
              >
                进入事件 →
              </Link>
              <button onClick={() => setJustCreated(null)} style={{ border: 0, background: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14 }}>×</button>
            </section>
          )}

          {/* 定高 panel（与任务/报告/通知统一）：内部分组滚动 */}
          <section style={{
            background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13,
            padding: 22, height: "calc(100vh - 320px)", minHeight: 460,
            display: "flex", flexDirection: "column",
          }}>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {events.length === 0 && (
                <p style={{ textAlign: "center", fontSize: 13, color: "var(--muted)", padding: "48px 0" }}>暂无事件</p>
              )}

              {upcoming.length > 0 && (
                <>
                  <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>Upcoming</p>
                  <h2 style={{ margin: "0 0 6px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>即将发生</h2>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {upcoming.map((ev, i) => (
                      <EventCard
                        key={ev.id} event={ev} productionId={productionId} first={i === 0}
                        role={roles.get(ev.id) ?? null} canViewFull={canViewFull}
                        taskCount={taskCounts[ev.id] ?? 0}
                        onFollow={handleFollow} onUnfollow={handleUnfollow}
                      />
                    ))}
                  </div>
                </>
              )}

              {past.length > 0 && (
                <>
                  <p style={{ margin: `${upcoming.length > 0 ? 26 : 0}px 0 4px`, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>Past</p>
                  <h2 style={{ margin: "0 0 6px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>已过去</h2>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {past.map((ev, i) => (
                      <EventCard
                        key={ev.id} event={ev} productionId={productionId} first={i === 0}
                        role={roles.get(ev.id) ?? null} canViewFull={canViewFull}
                        taskCount={taskCounts[ev.id] ?? 0}
                        onFollow={handleFollow} onUnfollow={handleUnfollow}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </section>
        </>
      )}

      {showCreate && (
        <CreateEventModal
          productionId={productionId}
          departments={departments}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
