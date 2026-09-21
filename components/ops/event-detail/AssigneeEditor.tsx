"use client";

import { useState } from "react";
import ChevronIcon from "@/components/ui/ChevronIcon";
import type { MemberWithRoles } from "@/lib/perm/member-db";
import type { EventTechReq } from "@/lib/ops/event-db";
import MemberCard from "./MemberCard";
import { groupByRole } from "./group-by-role";

export default function AssigneeEditor({
  req, members, allMembers, canEdit, onSave,
}: {
  req: EventTechReq; members: MemberWithRoles[];
  allMembers?: MemberWithRoles[];
  canEdit: boolean; onSave: (assignees: { userId: string; name: string }[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const assigneeSet = new Set(req.assignees.map(a => a.userId));

  const hasOutside = !!allMembers && allMembers.length > members.length;
  const pool = showAll && hasOutside ? allMembers! : members;

  function toggle(m: MemberWithRoles) {
    const next = assigneeSet.has(m.userId)
      ? req.assignees.filter(a => a.userId !== m.userId)
      : [...req.assignees, { userId: m.userId, name: m.name }];
    onSave(next);
  }

  if (!canEdit) {
    return req.assignees.length > 0 ? (
      <p className="text-xs text-zinc-400">负责人: {req.assignees.map(a => a.name).join(", ")}</p>
    ) : null;
  }

  const filtered = pool.filter(m =>
    !search || m.name.includes(search) || m.roles.some(r => r.includes(search))
  );
  const groups = groupByRole(filtered);

  return (
    <div>
      <button onClick={() => setEditing(!editing)} className="mb-2 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700">
        <ChevronIcon direction={editing ? "up" : "down"} size={12} />
        {editing ? "收起" : "编辑负责人"}
      </button>
      {editing && (
        <div className="flex flex-col gap-2">
          <input placeholder="搜索姓名或职位…" value={search} onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
          {hasOutside && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} className="rounded" />
              <span className="text-xs text-zinc-500">显示全部成员</span>
            </label>
          )}
          {filtered.length === 0 && <p className="text-xs text-zinc-400">无匹配成员</p>}
          <div className="max-h-64 overflow-y-auto flex flex-col gap-3">
            {groups.map(({ role, members: gm }) => (
              <div key={role}>
                <p className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-1.5">{role}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {gm.map(m => (
                    <MemberCard key={m.userId} m={m} isSelected={assigneeSet.has(m.userId)} onToggle={() => toggle(m)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
