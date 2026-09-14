"use client";

import { useState } from "react";
import type { MemberWithRoles } from "@/lib/db";
import type { ScheduleItemParticipant, EventDepartment } from "@/lib/ops/event-db";
import MemberCard from "./MemberCard";
import { groupByRole } from "./group-by-role";

export default function ParticipantPicker({
  members, selected, onChange,
  departments = [], selectedDeptIds = [], onDeptIdsChange,
}: {
  members: MemberWithRoles[];
  selected: ScheduleItemParticipant[];
  onChange: (next: ScheduleItemParticipant[]) => void;
  departments?: EventDepartment[];
  selectedDeptIds?: string[];
  onDeptIdsChange?: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selectedSet = new Set(selected.map(p => p.userId));
  const memberMap = new Map(members.map(m => [m.userId, m]));

  // Build dept groups (each member shown in every dept they belong to)
  const deptGroups = departments
    .map(dept => ({
      dept,
      members: dept.memberUserIds
        .map(oid => memberMap.get(oid))
        .filter((m): m is MemberWithRoles => !!m),
    }))
    .filter(g => g.members.length > 0);

  // Role groups: members not in any dept
  const inAnyDept = new Set(departments.flatMap(d => d.memberUserIds));
  const nonDeptMembers = members.filter(m => !inAnyDept.has(m.userId));

  function toggle(m: MemberWithRoles) {
    if (selectedSet.has(m.userId)) {
      onChange(selected.filter(p => p.userId !== m.userId));
    } else {
      onChange([...selected, { userId: m.userId, name: m.name }]);
    }
  }

  function toggleDept(dept: EventDepartment, deptMembers: MemberWithRoles[]) {
    if (selectedDeptIds.includes(dept.id)) {
      // Detach dept but keep any members already in the participant list
      onDeptIdsChange?.(selectedDeptIds.filter(id => id !== dept.id));
    } else {
      // Attach dept and bulk-add all its members not yet selected
      onDeptIdsChange?.([...selectedDeptIds, dept.id]);
      const toAdd = deptMembers
        .filter(m => !selectedSet.has(m.userId))
        .map(m => ({ userId: m.userId, name: m.name }));
      if (toAdd.length > 0) onChange([...selected, ...toAdd]);
    }
  }

  // Apply search
  const filteredDeptGroups = deptGroups
    .map(g => ({
      ...g,
      members: search
        ? g.members.filter(m => m.name.includes(search) || m.roles.some(r => r.includes(search)))
        : g.members,
    }))
    .filter(g => !search || g.members.length > 0);

  const filteredNonDept = search
    ? nonDeptMembers.filter(m => m.name.includes(search) || m.roles.some(r => r.includes(search)))
    : nonDeptMembers;
  const roleGroups = groupByRole(filteredNonDept);

  const empty = filteredDeptGroups.every(g => g.members.length === 0) && filteredNonDept.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <input placeholder="搜索姓名或职位…" value={search} onChange={e => setSearch(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
      {empty && <p className="text-xs text-zinc-400">无匹配成员</p>}
      <div className="max-h-64 overflow-y-auto flex flex-col gap-3">
        {filteredDeptGroups.map(({ dept, members: gm }) => {
          const attached = selectedDeptIds.includes(dept.id);
          return (
            <div key={dept.id}>
              <button
                type="button"
                onClick={() => toggleDept(dept, gm)}
                className={`flex items-center gap-1.5 mb-1.5 hover:opacity-75 transition-opacity ${
                  attached ? "text-zinc-700" : "text-zinc-400"
                }`}
              >
                <span className="text-[11px] font-semibold tracking-widest uppercase">{dept.name}</span>
                {attached
                  ? <span className="text-[10px] rounded bg-zinc-700 text-white px-1 py-0.5 leading-none">已关联 ×</span>
                  : <span className="text-[10px] rounded border border-zinc-300 text-zinc-400 px-1 py-0.5 leading-none">+ 关联</span>
                }
              </button>
              <div className="grid grid-cols-2 gap-1.5">
                {gm.map(m => (
                  <MemberCard key={m.userId} m={m} isSelected={selectedSet.has(m.userId)} onToggle={() => toggle(m)} />
                ))}
              </div>
            </div>
          );
        })}
        {roleGroups.map(({ role, members: gm }) => (
          <div key={role}>
            <p className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-1.5">{role}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {gm.map(m => (
                <MemberCard key={m.userId} m={m} isSelected={selectedSet.has(m.userId)} onToggle={() => toggle(m)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
