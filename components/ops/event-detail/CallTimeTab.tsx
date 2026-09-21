"use client";

import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/perm/member-db";
import type { EventScheduleItemWithParticipants, EventCallTime, EventTechReq } from "@/lib/ops/event-db";
import { datetimeLocalToIso } from "@/lib/tz";
import PersonCallTimeRow from "./PersonCallTimeRow";

function computeSuggestedCallAt(
  userId: string,
  scheduleItems: EventScheduleItemWithParticipants[],
  techReqs: EventTechReq[],
  isStageManager: boolean,
): string | null {
  if (isStageManager) {
    const starts = scheduleItems.flatMap(i => i.startTime ? [new Date(i.startTime).getTime()] : []);
    if (starts.length === 0) return null;
    return new Date(Math.min(...starts) - 30 * 60_000).toISOString();
  }
  const times: number[] = [];
  for (const item of scheduleItems) {
    if (item.startTime && item.participants.some(p => p.userId === userId)) {
      times.push(new Date(item.startTime).getTime());
    }
  }
  for (const req of techReqs) {
    if (req.status === "awaiting") continue;
    if (!req.assignees.some(a => a.userId === userId)) continue;
    if (req.presetMinutes == null) continue;
    for (const itemId of req.scheduleItemIds) {
      const item = scheduleItems.find(i => i.id === itemId);
      if (item?.startTime) {
        times.push(new Date(item.startTime).getTime() - req.presetMinutes * 60_000);
      }
    }
  }
  if (times.length === 0) return null;
  return new Date(Math.min(...times) - 15 * 60_000).toISOString();
}

export default function CallTimeTab({
  eventId, productionId, callTimes, eventPeople, scheduleItems, techReqs, members,
  stageManagerUserIds, canEdit, singleDay, eventDate,
  onCallTimesChange, versionId,
}: {
  eventId: string; productionId: string;
  callTimes: EventCallTime[];
  eventPeople: { userId: string; name: string }[];
  scheduleItems: EventScheduleItemWithParticipants[];
  techReqs: EventTechReq[];
  members: MemberWithRoles[];
  stageManagerUserIds: Set<string>;
  canEdit: boolean;
  singleDay: boolean; eventDate: string;
  onCallTimesChange: (cts: EventCallTime[]) => void;
  versionId: string | null;
}) {
  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/call-times`;
  const callTimeMap = new Map(callTimes.map(ct => [ct.userId, ct]));

  async function saveCallTime(userId: string, name: string, callAt: string, notes: string) {
    const existing = callTimeMap.get(userId);
    if (existing) {
      const res = await fetch(`${base}/${existing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callAt: datetimeLocalToIso(callAt), notes }),
      });
      const data = await res.json();
      if (data.callTime) onCallTimesChange(callTimes.map(ct => ct.id === existing.id ? data.callTime : ct));
    } else {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, name, callAt: datetimeLocalToIso(callAt), notes }),
      });
      const data = await res.json();
      if (data.callTime) onCallTimesChange([...callTimes, data.callTime]);
    }
  }

  async function deleteCallTime(userId: string) {
    const existing = callTimeMap.get(userId);
    if (!existing) return;
    await fetch(`${base}/${existing.id}`, { method: "DELETE" });
    onCallTimesChange(callTimes.filter(ct => ct.id !== existing.id));
  }

  if (eventPeople.length === 0) {
    return <p className="text-sm text-zinc-400 text-center py-6">先在流程项中添加参与人员</p>;
  }

  const memberMap = new Map(members.map(m => [m.userId, m]));
  const roleOrder: string[] = [];
  const roleGroups = new Map<string, { userId: string; name: string }[]>();
  for (const person of eventPeople) {
    const role = memberMap.get(person.userId)?.roles[0] ?? "其他";
    if (!roleGroups.has(role)) { roleGroups.set(role, []); roleOrder.push(role); }
    roleGroups.get(role)!.push(person);
  }

  return (
    <div className="flex flex-col gap-4">
      {roleOrder.map(role => (
        <div key={role}>
          <p className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-2">{role}</p>
          <div className="flex flex-col gap-2">
            {roleGroups.get(role)!.map(person => {
              const suggested = computeSuggestedCallAt(person.userId, scheduleItems, techReqs, stageManagerUserIds.has(person.userId));
              return (
                <PersonCallTimeRow
                  key={person.userId}
                  person={person}
                  callTime={callTimeMap.get(person.userId) ?? null}
                  suggestedCallAt={suggested}
                  canEdit={canEdit}
                  singleDay={singleDay} eventDate={eventDate}
                  productionId={productionId}
                  versionId={versionId}
                  onSave={(callAt, notes) => saveCallTime(person.userId, person.name, callAt, notes)}
                  onDelete={() => deleteCallTime(person.userId)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
