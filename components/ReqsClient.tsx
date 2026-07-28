"use client";

import type { CSSProperties } from "react";
import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { ProductionEvent, EventTechReq, EventDepartment } from "@/lib/event-db";
import SmartText, { scriptRefTextPlugin } from "@/components/SmartText";

const STATUS_OPTIONS = [
  { value: "pending",     label: "待处理" },
  { value: "in_progress", label: "进行中" },
  { value: "done",        label: "完成"   },
];
const STATUS_LABELS: Record<string, string> = {
  awaiting:    "待确认",
  pending:     "待处理",
  in_progress: "进行中",
  done:        "完成",
};
const STATUS_COLOR_STYLES: Record<string, { background: string; color: string }> = {
  awaiting:    { background: "#f5f3ff", color: "#8b5cf6" },
  pending:     { background: "#fffbeb", color: "#d97706" },
  in_progress: { background: "#eff6ff", color: "#2563eb" },
  done:        { background: "#f0fdf4", color: "#16a34a" },
};

const card: CSSProperties = {
  background: "white", border: "1px solid var(--line)", borderRadius: 12, padding: "20px 24px",
};
const rule: CSSProperties = { border: "none", borderTop: "1px solid var(--line)", margin: 0 };

type Props = {
  productionId: string;
  eventId: string;
  event: ProductionEvent;
  techReqs: EventTechReq[];
  departments: EventDepartment[];
  currentUserId: string;
  productionMembers: { userId: string; name: string }[];
  canViewFull?: boolean;
};

// ─── Awaiting card for POC — links to detail page ────────────────────────────

function AwaitingReqCard({
  req, deptName, productionId,
}: {
  req: EventTechReq;
  deptName: string | undefined;
  productionId: string;
  eventId: string;
}) {
  return (
    <Link
      href={`/production/${productionId}/tasks/${req.id}`}
      style={{ ...card, display: "flex", alignItems: "center", gap: 12, textDecoration: "none" }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {deptName && (
          <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", ...STATUS_COLOR_STYLES.awaiting }}>
            {deptName} · 待确认
          </p>
        )}
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: req.title ? "var(--ink)" : "var(--muted)", fontStyle: req.title ? "normal" : "italic" }}>
          {req.title || "待填写需求名称…"}
        </p>
      </div>
      <span style={{ flexShrink: 0, fontSize: 14, color: "var(--muted)" }}>›</span>
    </Link>
  );
}

// ─── Regular req card ─────────────────────────────────────────────────────────

function ReqCard({
  req, deptName, isMyReq, isPocOfDept, canViewFull, productionId, eventId, onStatusChange,
}: {
  req: EventTechReq;
  deptName: string | undefined;
  isMyReq: boolean;
  isPocOfDept: boolean;
  canViewFull?: boolean;
  productionId: string;
  eventId: string;
  onStatusChange: (reqId: string, newStatus: string) => void;
}) {
  const [status, setStatus] = useState(req.status);
  const [saving, setSaving] = useState(false);

  async function changeStatus(newStatus: string) {
    setSaving(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/events/${eventId}/tech-reqs/${req.id}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        }
      );
      if (res.ok) {
        setStatus(newStatus);
        onStatusChange(req.id, newStatus);
      }
    } finally {
      setSaving(false);
    }
  }

  const statusStyle = STATUS_COLOR_STYLES[status] ?? { background: "var(--paper)", color: "var(--muted)" };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {deptName && (
            <p style={{ margin: "0 0 4px", fontSize: 11, color: "var(--muted)" }}>{deptName}</p>
          )}
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{req.title}</h3>
        </div>
        {isMyReq ? (
          <div style={{ display: "flex", gap: 4, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {STATUS_OPTIONS.map(opt => {
              const active = status === opt.value;
              const optStyle = STATUS_COLOR_STYLES[opt.value] ?? { background: "var(--paper)", color: "var(--muted)" };
              return (
                <button
                  key={opt.value}
                  onClick={() => changeStatus(opt.value)}
                  disabled={saving || active}
                  style={{
                    borderRadius: 8, padding: "3px 10px", fontSize: 11, fontWeight: 600, border: 0,
                    cursor: active || saving ? "default" : "pointer",
                    opacity: saving && !active ? 0.5 : 1,
                    ...(active ? optStyle : { background: "var(--paper)", color: "var(--muted)" }),
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        ) : (
          <span style={{ flexShrink: 0, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, ...statusStyle }}>
            {STATUS_LABELS[status] ?? status}
          </span>
        )}
      </div>

      {req.description && (
        <>
          <hr style={{ ...rule, margin: "12px 0 10px" }} />
          <SmartText content={req.description} plugins={[scriptRefTextPlugin]} className="text-xs text-zinc-500" productionId={productionId} />
        </>
      )}

      {req.assignees.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10 }}>
          <span style={{ fontSize: 11, color: "var(--muted)", alignSelf: "center", marginRight: 2 }}>负责人:</span>
          {req.assignees.map(a => (
            <span key={a.userId} style={{ fontSize: 11, background: "var(--paper)", color: "var(--muted)", borderRadius: 4, padding: "2px 8px" }}>
              {a.name}
            </span>
          ))}
        </div>
      )}

      {(canViewFull || isPocOfDept || isMyReq) && (
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <Link
            href={`/production/${productionId}/tasks/${req.id}`}
            style={{ fontSize: 11, color: "var(--muted)", textDecoration: "none" }}
          >
            详情 →
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ReqsClient({
  productionId, eventId, event,
  techReqs, departments, currentUserId, productionMembers, canViewFull,
}: Props) {
  const [reqs, setReqs] = useState(techReqs);

  const deptMap = new Map(departments.map(d => [d.id, d]));

  const pocDeptIds = new Set(
    departments.filter(d => d.pocUserIds.includes(currentUserId)).map(d => d.id)
  );

  function handleStatusChange(reqId: string, newStatus: string) {
    setReqs(prev => prev.map(r => r.id === reqId ? { ...r, status: newStatus } : r));
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>

      {/* Eyebrow + nav */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", margin: 0 }}>
          Tech Reqs
        </p>
        <Link
          href={`/production/${productionId}/events/${eventId}/view`}
          style={{ fontSize: 11, color: "var(--muted)", textDecoration: "none" }}
        >
          ← 事件详情
        </Link>
      </div>

      {/* Page title */}
      <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", margin: "0 0 4px" }}>
        技术需求
      </h1>
      <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 20px" }}>{event.title}</p>

      {reqs.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "48px 0" }}>暂无技术需求</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {reqs.map(req => {
            const dept = req.departmentId ? deptMap.get(req.departmentId) : undefined;
            const deptName = dept?.name;
            const isPocOfDept = req.departmentId ? pocDeptIds.has(req.departmentId) : false;

            if (req.status === "awaiting" && isPocOfDept) {
              return (
                <AwaitingReqCard
                  key={req.id}
                  req={req}
                  deptName={deptName}
                  productionId={productionId}
                  eventId={eventId}
                />
              );
            }

            return (
              <ReqCard
                key={req.id}
                req={req}
                deptName={deptName}
                isMyReq={req.assignees.some(a => a.userId === currentUserId)}
                isPocOfDept={isPocOfDept}
                canViewFull={canViewFull}
                productionId={productionId}
                eventId={eventId}
                onStatusChange={handleStatusChange}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
