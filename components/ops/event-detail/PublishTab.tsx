"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { ProductionEvent, EventScheduleItemWithParticipants, EventCallTime, EventTechReq } from "@/lib/ops/event-db";
import EventChatSection from "./EventChatSection";
import { STATUS_LABELS, STATUS_COLORS } from "./labels";

function ChecklistItem({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
        done ? "bg-green-100 text-green-600" : "bg-zinc-100 text-zinc-300"
      }`}>
        {done ? "✓" : "·"}
      </div>
      <span className={`text-sm ${done ? "text-zinc-700" : "text-zinc-400"}`}>{label}</span>
    </div>
  );
}

export default function PublishTab({
  event, productionId, scheduleItems, callTimes, eventPeople, techReqs, canEdit, onUpdated,
  onAllTechReqsCompleted,
}: {
  event: ProductionEvent; productionId: string;
  scheduleItems: EventScheduleItemWithParticipants[];
  callTimes: EventCallTime[];
  eventPeople: { userId: string; name: string }[];
  techReqs: EventTechReq[];
  canEdit: boolean;
  onUpdated: (ev: ProductionEvent) => void;
  onAllTechReqsCompleted?: () => void;
}) {
  const awaitingCount = techReqs.filter(r => r.status === "awaiting").length;
  const [urging, setUrging] = useState(false);

  async function urgeReqs() {
    setUrging(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/notify-awaiting-reqs`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.notified != null) alert(`已向 ${data.notified} 个部门群发送催确认通知`);
      else alert(data.error ?? "发送失败");
    } finally { setUrging(false); }
  }

  async function changeStatus(status: string) {
    if (status === "published" && awaitingCount > 0) {
      if (!confirm(`还有 ${awaitingCount} 个待确认需求未处理，确定要发布吗？`)) return;
    }
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (data.event) {
      onUpdated(data.event);
      if (status === "completed") onAllTechReqsCompleted?.();
    }
  }

  const callTimesNeeded = eventPeople.length;
  const callTimesSet = callTimes.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[event.status] ?? "bg-zinc-100 text-zinc-400"}`}>
          {STATUS_LABELS[event.status] ?? event.status}
        </span>
      </div>

      <EventChatSection
        event={event} productionId={productionId} canEdit={canEdit}
        onChatIdSet={chatId => onUpdated({ ...event, chatId })}
        onChatIdCleared={() => onUpdated({ ...event, chatId: null })}
      />

      <div className="flex flex-col gap-2.5">
        <ChecklistItem
          done={!!(event.startTime || event.endTime)}
          label="事件时间已设置"
        />
        <ChecklistItem
          done={scheduleItems.length > 0}
          label={`事件流程 · ${scheduleItems.length} 项`}
        />
        <ChecklistItem
          done={callTimesNeeded > 0 && callTimesSet >= callTimesNeeded}
          label={`Call Time · ${callTimesSet} / ${callTimesNeeded} 人`}
        />
        <div className="flex items-center gap-3">
          <ChecklistItem
            done={awaitingCount === 0}
            label={awaitingCount === 0 ? "技术需求已全部确认" : `${awaitingCount} 个技术需求待确认`}
          />
          {canEdit && awaitingCount > 0 && (
            <button onClick={urgeReqs} disabled={urging}
              className="px-2.5 py-1 rounded-lg border border-red-200 text-xs text-red-500 hover:bg-red-50 disabled:opacity-50 shrink-0">
              {urging ? "…" : "催确认"}
            </button>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {event.status === "draft" && (
            <button onClick={() => changeStatus("published")}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
              发布
            </button>
          )}
          {event.status === "published" && (
            <>
              <button onClick={() => changeStatus("completed")}
                className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700">
                标记完成
              </button>
              <button onClick={() => changeStatus("draft")}
                className="px-4 py-2 rounded-lg border border-zinc-200 text-sm text-zinc-600 hover:bg-zinc-50">
                撤回草稿
              </button>
            </>
          )}
          {event.status === "completed" && (
            <button onClick={() => changeStatus("draft")}
              className="px-4 py-2 rounded-lg border border-zinc-200 text-sm text-zinc-600 hover:bg-zinc-50">
              重新开放
            </button>
          )}
          {event.status !== "cancelled" && (
            <button onClick={() => changeStatus("cancelled")}
              className="px-4 py-2 rounded-lg border border-red-200 text-sm text-red-500 hover:bg-red-50">
              取消事件
            </button>
          )}
        </div>
      )}

    </div>
  );
}
