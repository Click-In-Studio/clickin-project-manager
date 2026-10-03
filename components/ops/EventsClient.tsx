"use client";

import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";

import { useState, Fragment } from "react";
import Link from "next/link";
import type React from "react";
import { BASE_PATH } from "@/lib/base-path";
import ProductionModuleTopMenu, {
  PRODUCTION_MODULE_ACTION_CLASS,
  PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS,
} from "@/components/shell/ProductionModuleTopMenu";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import type { ProductionEvent, EventDepartment } from "@/lib/ops/event-db";
import { fmtDateTimeSmart, datetimeLocalToIso, dateTimeToIso, isoCSTDateStr } from "@/lib/tz";
import responsive from "@/components/ops/responsive.module.css";

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
  const [hovered, setHovered] = useState(false);

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
  const eventDateParts = event.startTime
    ? isoCSTDateStr(event.startTime).split("-").map(Number)
    : null;

  const go = (href: string) => { window.location.href = `${BASE_PATH}${href}`; };
  const stopAndGo = (e: React.MouseEvent, href: string) => {
    e.preventDefault();
    e.stopPropagation();
    go(href);
  };

  return (
    <article
      className={responsive.eventCard}
      role="link"
      tabIndex={0}
      aria-label={`查看事件：${event.title}`}
      onClick={e => { if (!(e.target as HTMLElement).closest("button,a")) go(detailHref); }}
      onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); go(detailHref); } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderTop: first ? 0 : "1px solid var(--line)",
        background: hovered ? "var(--paper)" : "transparent",
      }}
    >
      {/* 左列：日期与类型共用一条固定层级。 */}
      <div className={responsive.eventDateColumn}>
        <time className={responsive.eventDateBox}>
          {eventDateParts ? (
            <>
              <b className={responsive.eventDateDay}>{eventDateParts[2]}</b>
              <small className={responsive.eventDateMonth}>
                {eventDateParts[1]} 月
              </small>
            </>
          ) : (
            <small className={responsive.eventDateMonth}>待定</small>
          )}
        </time>
        <Badge tone={typeTone}>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</Badge>
      </div>

      {/* 中列：草稿提示 → 标题 → 时间地点。 */}
      <div className={responsive.eventContent}>
        {event.status === "draft" && (
          <div className={responsive.eventContentBadges}><Badge>草稿</Badge></div>
        )}
        <h3 className={responsive.eventTitle}>
          <Link href={detailHref} style={{ color: "inherit", textDecoration: "none" }}>
            {event.title}
          </Link>
        </h3>
        <p className={responsive.eventMeta}>
          {[event.startTime && fmtDateTimeSmart(event.startTime), event.location].filter(Boolean).join(" · ")}
        </p>
      </div>

      {/* 右列：eventStatus 丸 + 关注 */}
      <div className={responsive.eventStatusColumn}>
        <span className={responsive.eventStatusPill} style={{
          ...(STATUS_COLORS[event.status] ?? STATUS_COLORS.draft),
          border: `1px solid ${event.status === "published" ? "#bfdbfe" : event.status === "completed" ? "#bbf7d0" : event.status === "cancelled" ? "#fecdd3" : "var(--line)"}`,
        }}>
          {statusText}
        </span>
        {role === "participant" ? (
          <span className={responsive.eventParticipation}>已参与</span>
        ) : (
          <button
            className={responsive.eventFollowButton}
            onClick={toggle}
            disabled={busy}
            style={{
              opacity: busy ? 0.5 : 1, transition: "all .1s",
              background: role === "follower" ? "var(--script-soft)" : "var(--paper)",
              color: role === "follower" ? "var(--script)" : "var(--muted)",
            }}
          >
            {role === "follower" ? "已关注" : "关注"}
          </button>
        )}
      </div>

      {/* inlineActions（原型：paper 底 script 色边框小按钮） */}
      <div className={responsive.eventCardActions}>
        <button className={responsive.eventCardActionButton} onClick={e => stopAndGo(e, detailHref)}>
          事件详情<span className={responsive.eventCardActionArrow} aria-hidden="true">→</span>
        </button>
        {canViewFull && (
          <button className={responsive.eventCardActionButton} onClick={e => stopAndGo(e, `/production/${productionId}/events/${event.id}/callsheet`)}>
            执行流程<span className={responsive.eventCardActionArrow} aria-hidden="true">→</span>
          </button>
        )}
        {taskCount > 0 && (
          <button className={responsive.eventCardActionButton} onClick={e => stopAndGo(e, `/production/${productionId}/tasks?event=${event.id}`)}>
            {taskCount} 个任务<span className={responsive.eventCardActionArrow} aria-hidden="true">→</span>
          </button>
        )}
      </div>
    </article>
  );
}

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

      // 事件与执行日程共用同一数据链：事件创建后立即生成默认流程项，
      // 这样事件页新建的内容会同时出现在计划月历与执行日程。
      const scheduleRes = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${data.event.id}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${title.trim()} · 执行日程`,
          itemType: eventType === "rehearsal" ? "scene_rehearsal" : eventType === "meeting" ? "meeting" : "custom",
          startTime: resolvedStart,
          endTime: resolvedEnd,
          location: location.trim(),
          notes: "由事件新建流程自动生成。",
          departmentIds: notifyDeptIds,
        }),
      });
      const scheduleData = await scheduleRes.json().catch(() => ({}));
      if (!scheduleRes.ok) {
        setError(`事件已创建，但执行日程生成失败：${scheduleData.error ?? "未知错误"}`);
        onCreated(data.event);
        return;
      }
      if (notifyDeptIds.length > 0 && data.event?.id) {
        await fetch(`${BASE_PATH}/api/production/${productionId}/events/${data.event.id}/awaiting-reqs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ departmentIds: notifyDeptIds, scheduleItemId: scheduleData.item?.id }),
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
              <OverflowSafeSelect value={eventType} onChange={e => setEventType(e.target.value)} style={inputStyle}>
                <option value="rehearsal">排练</option>
                <option value="performance">演出</option>
                <option value="meeting">会议</option>
                <option value="custom">其他</option>
              </OverflowSafeSelect>
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
    <div className={responsive.eventPage}>
      {canCreate && (
        <ProductionModuleTopMenu
          productionName={productionName}
          label="事件"
          primaryAction={<button type="button" onClick={() => setShowCreate(true)} className={PRODUCTION_MODULE_ACTION_CLASS}>＋ 新建事件</button>}
          primaryShortAction={<button type="button" aria-label="新建事件" onClick={() => setShowCreate(true)} className={PRODUCTION_MODULE_ACTION_CLASS}>＋</button>}
          primaryOverflowAction={<button type="button" onClick={() => setShowCreate(true)} className={PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS}>新建事件</button>}
        />
      )}

      {/* Content（日历模式已移除——项目日历归"计划与日程"面板） */}
      {(
        <>
          {/* 三步流程说明条（原型 flowExplainer：三卡 + 箭头——设计语言保留；
              高度对齐各页摘要卡 92px 体系） */}
          {canCreate && (
            <section className={responsive.flowExplainer}>
              {[["1", "定义事件", "类型、时间、地点、人员"],
                ["2", "确认任务", "负责人、截止、通知对象"],
                ["3", "发布与追踪", "站内通知、确认、执行"]].map(([n, t, s], i) => (
                <Fragment key={n}>
                  {i > 0 && <i className={responsive.flowArrow}>→</i>}
                  <div className={responsive.flowCard}>
                    <span className={responsive.flowNumber}>{n}</span>
                    <b className={responsive.flowTitle}>{t}</b>
                    <small className={responsive.flowDescription}>{s}</small>
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

          <div className={responsive.eventGroupGrid}>
            {([
              { key: "upcoming", eyebrow: "Upcoming", title: "即将发生", items: upcoming },
              { key: "past", eyebrow: "Past", title: "已过去", items: past },
            ] as const).map(group => (
              <section key={group.key} className={responsive.eventGroup}>
                <div style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                  <div>
                    <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>{group.eyebrow}</p>
                    <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>{group.title}</h2>
                  </div>
                  <span style={{ color: "var(--muted)", fontSize: 10 }}>{group.items.length} 个事件</span>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                  {group.items.length === 0 ? (
                    <p style={{ textAlign: "center", fontSize: 12, color: "var(--muted)", padding: "48px 0" }}>暂无{group.title}的事件</p>
                  ) : group.items.map((ev, i) => (
                    <EventCard
                      key={ev.id} event={ev} productionId={productionId} first={i === 0}
                      role={roles.get(ev.id) ?? null} canViewFull={canViewFull}
                      taskCount={taskCounts[ev.id] ?? 0}
                      onFollow={handleFollow} onUnfollow={handleUnfollow}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
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
