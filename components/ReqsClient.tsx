"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import type { ProductionEvent, EventTechReq, EventDepartment } from "@/lib/event-db";

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
const STATUS_COLORS: Record<string, string> = {
  awaiting:    "bg-purple-50 text-purple-500",
  pending:     "bg-amber-50 text-amber-600",
  in_progress: "bg-blue-50 text-blue-600",
  done:        "bg-green-50 text-green-600",
};

type Props = {
  productionId: string;
  eventId: string;
  event: ProductionEvent;
  techReqs: EventTechReq[];
  departments: EventDepartment[];
  currentUserOpenId: string;
  productionMembers: { openId: string; name: string }[];
};

// ─── Awaiting card for POC — links to detail page ────────────────────────────

function AwaitingReqCard({
  req, deptName, productionId, eventId,
}: {
  req: EventTechReq;
  deptName: string | undefined;
  productionId: string;
  eventId: string;
}) {
  return (
    <Link
      href={`/production/${productionId}/events/${eventId}/reqs/${req.id}`}
      className="bg-white rounded-2xl shadow-sm px-5 py-4 flex items-start gap-3 hover:shadow-md transition-shadow"
    >
      <div className="flex-1 min-w-0">
        {deptName && (
          <span className="inline-block text-[11px] font-medium text-purple-500 bg-purple-50 rounded px-1.5 py-0.5 mb-1">
            {deptName} · 待确认
          </span>
        )}
        <p className={`text-sm font-medium ${req.title ? "text-zinc-800" : "text-zinc-400 italic"}`}>
          {req.title || "待填写需求名称…"}
        </p>
      </div>
      <span className="shrink-0 text-zinc-300 text-xs mt-1">→</span>
    </Link>
  );
}

// ─── Regular req card ─────────────────────────────────────────────────────────

function ReqCard({
  req, deptName, isMyReq, productionId, eventId, onStatusChange,
}: {
  req: EventTechReq;
  deptName: string | undefined;
  isMyReq: boolean;
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

  return (
    <div className="bg-white rounded-2xl shadow-sm px-5 py-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-zinc-800">{req.title}</h3>
          {deptName && (
            <span className="text-[11px] text-zinc-400">{deptName}</span>
          )}
        </div>
        {isMyReq ? (
          <div className="flex gap-1 shrink-0 flex-wrap justify-end">
            {STATUS_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => changeStatus(opt.value)}
                disabled={saving || status === opt.value}
                className={`rounded-lg px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-default ${
                  status === opt.value
                    ? (STATUS_COLORS[opt.value] ?? "bg-zinc-100 text-zinc-500") + " ring-1 ring-current ring-opacity-30"
                    : "bg-zinc-50 text-zinc-400 hover:bg-zinc-100 disabled:opacity-60"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : (
          <span className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium ${STATUS_COLORS[status] ?? "bg-zinc-100 text-zinc-500"}`}>
            {STATUS_LABELS[status] ?? status}
          </span>
        )}
      </div>

      {req.description && (
        <p className="text-xs text-zinc-500 mb-2 whitespace-pre-wrap">{req.description}</p>
      )}

      {req.assignees.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          <span className="text-[10px] text-zinc-400 mr-1 self-center">负责人:</span>
          {req.assignees.map(a => (
            <span key={a.openId} className="text-[10px] bg-zinc-50 text-zinc-500 rounded px-1.5 py-0.5">
              {a.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ReqsClient({
  productionId, eventId, event,
  techReqs, departments, currentUserOpenId, productionMembers,
}: Props) {
  const [reqs, setReqs] = useState(techReqs);

  const deptMap = new Map(departments.map(d => [d.id, d]));

  // Depts where current user is POC
  const pocDeptIds = new Set(
    departments.filter(d => d.pocOpenIds.includes(currentUserOpenId)).map(d => d.id)
  );

  // For each dept, compute eligible assignees (members + pocs of that dept)
  function getDeptPeople(deptId: string | null): { openId: string; name: string }[] {
    if (!deptId) return [];
    const dept = deptMap.get(deptId);
    if (!dept) return [];
    const eligible = new Set([...dept.memberOpenIds, ...dept.pocOpenIds]);
    return productionMembers.filter(m => eligible.has(m.openId));
  }

  function handleConfirmed(
    reqId: string, newStatus: string,
    title: string, description: string,
    assignees: { openId: string; name: string }[],
  ) {
    setReqs(prev => prev.map(r =>
      r.id === reqId ? { ...r, status: newStatus, title, description, assignees } : r
    ));
  }

  function handleStatusChange(reqId: string, newStatus: string) {
    setReqs(prev => prev.map(r => r.id === reqId ? { ...r, status: newStatus } : r));
  }

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-xl mx-auto px-4 pt-8 pb-16">
        <div className="flex items-center gap-3 mb-5 text-xs text-zinc-400">
          <Link href={`/production/${productionId}/events/${eventId}/view`} className="hover:text-zinc-600">
            ← 事件详情
          </Link>
        </div>

        <div className="mb-6">
          <h1 className="text-lg font-bold text-zinc-800">技术需求</h1>
          <p className="text-xs text-zinc-400 mt-1">{event.title}</p>
        </div>

        {reqs.length === 0 ? (
          <p className="text-center text-sm text-zinc-400 py-12">暂无技术需求</p>
        ) : (
          <div className="flex flex-col gap-3">
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
                  isMyReq={req.assignees.some(a => a.openId === currentUserOpenId)}
                  productionId={productionId}
                  eventId={eventId}
                  onStatusChange={handleStatusChange}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
