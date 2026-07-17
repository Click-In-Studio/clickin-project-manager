"use client";

import Link from "next/link";
import type { MyTechReqFullEntry } from "@/lib/event-db";

const STATUS_LABELS: Record<string, string> = {
  awaiting: "待确认", pending: "待处理", in_progress: "进行中", done: "完成",
};
const STATUS_COLORS: Record<string, string> = {
  awaiting:    "bg-purple-50 text-purple-500",
  pending:     "bg-amber-50 text-amber-600",
  in_progress: "bg-blue-50 text-blue-600",
  done:        "bg-green-50 text-green-600",
};

function ReqLinkCard({ req }: { req: MyTechReqFullEntry }) {
  const href = `/production/${req.productionId}/events/${req.eventId}/reqs/${req.id}`;
  return (
    <Link href={href}
      className="bg-white rounded-2xl shadow-sm px-5 py-4 flex items-start gap-3 hover:shadow-md transition-shadow">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          {req.departmentName && (
            <span className={`text-[11px] font-medium rounded px-1.5 py-0.5 ${STATUS_COLORS[req.status]}`}>
              {req.departmentName}
            </span>
          )}
          <span className="text-[11px] text-zinc-400 truncate">{req.eventTitle}</span>
          <span className="text-[11px] text-zinc-300">· {req.productionName}</span>
        </div>
        <p className={`text-sm font-medium ${req.title ? "text-zinc-800" : "text-zinc-400 italic"}`}>
          {req.title || "待填写需求名称…"}
        </p>
        {req.assignees.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {req.assignees.map(a => (
              <span key={a.openId} className="text-[10px] bg-zinc-50 text-zinc-500 rounded px-1.5 py-0.5">
                {a.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium ${STATUS_COLORS[req.status] ?? "bg-zinc-100 text-zinc-500"}`}>
        {STATUS_LABELS[req.status] ?? req.status}
      </span>
    </Link>
  );
}

type Props = {
  reqs: MyTechReqFullEntry[];
  currentUserOpenId: string;
};

export default function MyReqsClient({ reqs }: Props) {
  const awaitingReqs = reqs.filter(r => r.status === "awaiting");
  const activeReqs   = reqs.filter(r => r.status !== "awaiting");

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-xl mx-auto px-4 pt-8 pb-16">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/" className="text-xs text-zinc-400 hover:text-zinc-600">← 首页</Link>
          <h1 className="text-sm font-bold tracking-[0.15em] text-zinc-400 uppercase">My Reqs</h1>
        </div>

        {awaitingReqs.length === 0 && activeReqs.length === 0 && (
          <p className="text-center text-sm text-zinc-400 py-12">暂无需求</p>
        )}

        {awaitingReqs.length > 0 && (
          <section className="mb-6">
            <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase mb-3">
              待确认 · {awaitingReqs.length}
            </p>
            <div className="flex flex-col gap-3">
              {awaitingReqs.map(req => <ReqLinkCard key={req.id} req={req} />)}
            </div>
          </section>
        )}

        {activeReqs.length > 0 && (
          <section>
            <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase mb-3">
              待完成 · {activeReqs.length}
            </p>
            <div className="flex flex-col gap-3">
              {activeReqs.map(req => <ReqLinkCard key={req.id} req={req} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
