"use client";

import { useMemo, useState } from "react";
import AdminModal from "@/components/AdminModal";
import Badge from "@/components/Badge";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";

export type PickerMember = {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  photoUrl?: string | null;
  roles: string[];
  tags: string[];
  /** 联系方式按 contact@view 裁剪后传入；无权时为 null，搜索自然覆盖不到 */
  email?: string | null;
  phone?: string | null;
  status: "active" | "suspended";
};

export type PickerDept = {
  id: string;
  name: string;
  parentId: string | null;
  kind: "dept" | "group";
  memberUserIds: string[];
};

type Props = {
  kicker?: string;
  title: string;
  members: PickerMember[];
  depts: PickerDept[];
  /** 已不可选（如已在部门/已有该角色）的成员——从列表中隐去 */
  excludeUserIds?: string[];
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: (userIds: string[]) => void | Promise<void>;
  onClose: () => void;
};

const NO_TAG = "__none__";

function Avatar({ m }: { m: PickerMember }) {
  const url = m.photoUrl || m.avatarUrl;
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
  ) : (
    <span style={{
      width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
      background: "var(--script-soft)", color: "var(--script)",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontSize: 10, fontWeight: 700,
    }}>
      {m.name.slice(0, 1) || "?"}
    </span>
  );
}

export default function MemberPickerModal({
  kicker, title, members, depts, excludeUserIds = [], confirmLabel = "确认添加", busy, onConfirm, onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const excluded = useMemo(() => new Set(excludeUserIds), [excludeUserIds]);
  const allTags = useMemo(() => [...new Set(members.flatMap(m => m.tags))].sort(), [members]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return new Set(
      members
        .filter(m => !excluded.has(m.userId))
        .filter(m => {
          if (tagFilter === NO_TAG) { if (m.tags.length > 0) return false; }
          else if (tagFilter) { if (!m.tags.includes(tagFilter)) return false; }
          if (!q) return true;
          return (
            m.name.toLowerCase().includes(q) ||
            m.roles.some(r => r.toLowerCase().includes(q)) ||
            (m.email ?? "").toLowerCase().includes(q) ||
            (m.phone ?? "").includes(q)
          );
        })
        .map(m => m.userId),
    );
  }, [members, excluded, query, tagFilter]);

  const memberMap = useMemo(() => new Map(members.map(m => [m.userId, m])), [members]);

  // 部门树顺序（子级缩进）；成员挂多部门会在各组出现，勾选状态共享
  const tree = useMemo(() => {
    const byParent = new Map<string | null, PickerDept[]>();
    const ids = new Set(depts.map(d => d.id));
    for (const d of depts) {
      const key = d.parentId && ids.has(d.parentId) ? d.parentId : null;
      byParent.set(key, [...(byParent.get(key) ?? []), d]);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const out: { dept: PickerDept; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const d of byParent.get(parent) ?? []) { out.push({ dept: d, depth }); walk(d.id, depth + 1); }
    };
    walk(null, 0);
    return out;
  }, [depts]);

  const assigned = useMemo(() => {
    const s = new Set<string>();
    for (const d of depts) d.memberUserIds.forEach(id => s.add(id));
    return s;
  }, [depts]);
  const unassigned = members.filter(m => !assigned.has(m.userId) && visible.has(m.userId));

  function toggle(userId: string) {
    setPicked(prev => {
      const s = new Set(prev);
      if (s.has(userId)) s.delete(userId); else s.add(userId);
      return s;
    });
  }

  function toggleCollapse(deptId: string) {
    setCollapsed(prev => {
      const s = new Set(prev);
      if (s.has(deptId)) s.delete(deptId); else s.add(deptId);
      return s;
    });
  }

  const FIELD: React.CSSProperties = {
    padding: "8px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8,
    background: "var(--paper)", color: "var(--ink)",
  };

  function memberRow(m: PickerMember, indent: number) {
    const on = picked.has(m.userId);
    return (
      <button
        key={m.userId}
        onClick={() => toggle(m.userId)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "5px 8px", paddingLeft: 8 + indent, borderRadius: 8,
          border: "none", cursor: "pointer", textAlign: "left",
          background: on ? "var(--script-soft)" : "transparent",
        }}
      >
        <span style={{
          width: 15, height: 15, borderRadius: 4, flexShrink: 0,
          border: "1.5px solid " + (on ? "var(--script)" : "var(--line)"),
          background: on ? "var(--script)" : "var(--paper)",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontSize: 10, lineHeight: 1,
        }}>
          {on ? "✓" : ""}
        </span>
        <Avatar m={m} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: m.status === "suspended" ? "var(--muted)" : "var(--ink)", textDecoration: m.status === "suspended" ? "line-through" : undefined, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {m.name || "（未命名）"}
          </span>
          <span style={{ display: "block", fontSize: 9.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {[m.roles.join(" · "), m.email ?? ""].filter(Boolean).join("  ") || "无角色"}
          </span>
        </span>
        {m.tags.map(t => <Badge key={t} tone="neutral">{t}</Badge>)}
      </button>
    );
  }

  return (
    <AdminModal kicker={kicker} title={title} onClose={onClose} width={520}>
      {/* 搜索 + tag 筛选 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          value={query} onChange={e => setQuery(e.target.value)} autoFocus
          placeholder="搜索姓名 / 角色 / 联系方式"
          style={{ ...FIELD, flex: 1 }}
        />
        <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} style={{ ...FIELD, maxWidth: 140 }}>
          <option value="">全部标签</option>
          <option value={NO_TAG}>无标签</option>
          {allTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {/* 部门树成员列表 */}
      <div style={{ maxHeight: "48vh", overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10, padding: 8, background: "var(--surface)" }}>
        {tree.map(({ dept, depth }) => {
          const ms = dept.memberUserIds
            .map(id => memberMap.get(id))
            .filter((m): m is PickerMember => !!m && visible.has(m.userId));
          if (ms.length === 0) return null;
          const isCollapsed = collapsed.has(dept.id);
          return (
            <div key={dept.id}>
              <button
                onClick={() => toggleCollapse(dept.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%",
                  padding: "5px 8px", paddingLeft: 8 + depth * 14,
                  border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{ fontSize: 9, color: "var(--muted)" }}>{isCollapsed ? "▸" : "▾"}</span>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", color: "var(--muted)", textTransform: "uppercase" }}>
                  {dept.name}
                </span>
                {dept.kind === "group" && <Badge tone="amber">组</Badge>}
                <span style={{ fontSize: 9.5, color: "var(--muted)" }}>{ms.length}</span>
              </button>
              {!isCollapsed && ms.map(m => memberRow(m, depth * 14 + 14))}
            </div>
          );
        })}
        {unassigned.length > 0 && (
          <div>
            <p style={{ margin: 0, padding: "5px 8px", fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", color: "var(--muted)", textTransform: "uppercase" }}>
              未分配部门
            </p>
            {unassigned.map(m => memberRow(m, 14))}
          </div>
        )}
        {visible.size === 0 && (
          <p style={{ margin: 0, padding: "22px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
            无匹配成员
          </p>
        )}
      </div>

      {/* footer */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
        <span style={{ flex: 1, fontSize: 11, color: picked.size ? "var(--ink)" : "var(--muted)", fontWeight: 700 }}>
          已选 {picked.size} 人
        </span>
        <button style={SECONDARY_BTN} onClick={onClose}>取消</button>
        <button
          style={PRIMARY_BTN}
          disabled={busy || picked.size === 0}
          onClick={() => onConfirm([...picked])}
        >
          {confirmLabel}
        </button>
      </div>
    </AdminModal>
  );
}
