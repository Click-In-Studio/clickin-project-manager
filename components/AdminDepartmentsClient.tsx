"use client";

import { useState, useRef, useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { EventDepartment } from "@/lib/event-db";
import type { MemberWithRoles } from "@/lib/db";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Tree node — currently flat (parentId always null),
 * ready for hierarchy once the DB field is added.
 */
type DeptNode = EventDepartment & { parentId: string | null; children: DeptNode[] };

function buildTree(depts: EventDepartment[]): DeptNode[] {
  const nodes: DeptNode[] = depts.map((d) => ({ ...d, parentId: null, children: [] }));
  // When parentId is supported, wire up children here.
  // For now every node is a root.
  return nodes;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
const tmpId = () => `dept${Date.now().toString(36)}${(++_seq).toString(36)}`;

// ─── Inline-edit input ────────────────────────────────────────────────────────

function InlineInput({
  initial,
  placeholder,
  onConfirm,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onConfirm: (v: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  return (
    <input
      ref={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); if (val.trim()) onConfirm(val.trim()); }
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => { if (val.trim()) onConfirm(val.trim()); else onCancel(); }}
      style={{
        flex: 1, fontSize: 13, fontWeight: 600, color: "var(--ink)",
        border: "none", borderBottom: "1.5px solid var(--ink)", outline: "none",
        background: "transparent", padding: "0 0 1px",
      }}
    />
  );
}

// ─── MemberRow ────────────────────────────────────────────────────────────────

function MemberRow({
  member,
  isMember,
  isPoc,
  onToggleMember,
  onTogglePoc,
}: {
  member: MemberWithRoles;
  isMember: boolean;
  isPoc: boolean;
  onToggleMember: () => void;
  onTogglePoc: () => void;
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "7px 12px", borderRadius: 8,
        background: isMember ? "var(--surface-2)" : "transparent",
        transition: "background .1s",
      }}
    >
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {member.name}
      </span>
      {member.roles.length > 0 && (
        <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0, marginRight: 4 }}>
          {member.roles[0]}
        </span>
      )}
      {/* Member toggle */}
      <button
        onClick={onToggleMember}
        title={isMember ? "移出部门" : "加入部门"}
        style={{
          flexShrink: 0, width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
          background: isMember ? "var(--ink)" : "var(--line)",
          position: "relative", transition: "background .15s",
        }}
      >
        <span style={{
          position: "absolute", top: 3, width: 16, height: 16, borderRadius: "50%", background: "#fff",
          left: isMember ? "calc(100% - 19px)" : 3,
          transition: "left .15s",
          boxShadow: "0 1px 3px rgba(0,0,0,.2)",
        }} />
      </button>
      {/* POC toggle */}
      <button
        onClick={onTogglePoc}
        title={isPoc ? "取消 POC" : "设为 POC"}
        style={{
          flexShrink: 0, width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
          background: isPoc ? "#d97706" : "var(--line)",
          position: "relative", transition: "background .15s",
        }}
      >
        <span style={{
          position: "absolute", top: 3, width: 16, height: 16, borderRadius: "50%", background: "#fff",
          left: isPoc ? "calc(100% - 19px)" : 3,
          transition: "left .15s",
          boxShadow: "0 1px 3px rgba(0,0,0,.2)",
        }} />
      </button>
    </div>
  );
}

// ─── DeptDetail (right panel) ─────────────────────────────────────────────────

function DeptDetail({
  dept,
  members,
  onUpdated,
  onDeleted,
  onMobileBack,
}: {
  dept: DeptNode;
  members: MemberWithRoles[];
  onUpdated: (d: EventDepartment) => void;
  onDeleted: () => void;
  onMobileBack?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const memberSet = new Set(dept.memberUserIds);
  const pocSet = new Set(dept.pocUserIds);

  const filtered = search.trim()
    ? members.filter((m) => m.name.includes(search) || m.roles.some((r) => r.includes(search)))
    : members;

  const saveDeptMembers = async (entries: { userId: string; isMember: boolean; isPoc: boolean }[]) => {
    setSaving(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${dept.productionId}/departments/${dept.id}/members`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ members: entries }) }
      );
      const data = await res.json();
      if (data.department) onUpdated(data.department);
    } finally {
      setSaving(false);
    }
  };

  const buildEntries = () => {
    const allIds = new Set([...dept.memberUserIds, ...dept.pocUserIds]);
    return new Map([...allIds].map((id) => [id, {
      userId: id,
      isMember: memberSet.has(id),
      isPoc: pocSet.has(id),
    }]));
  };

  const toggleMember = (userId: string) => {
    const entries = buildEntries();
    if (memberSet.has(userId)) {
      entries.delete(userId);
    } else {
      entries.set(userId, { userId, isMember: true, isPoc: pocSet.has(userId) });
    }
    saveDeptMembers([...entries.values()]);
  };

  const togglePoc = (userId: string) => {
    const entries = buildEntries();
    const newIsPoc = !pocSet.has(userId);
    const current = entries.get(userId) ?? { userId, isMember: false, isPoc: false };
    if (!newIsPoc && !current.isMember) {
      entries.delete(userId);
    } else {
      entries.set(userId, { ...current, isPoc: newIsPoc });
    }
    saveDeptMembers([...entries.values()]);
  };

  const handleDelete = async () => {
    if (!confirm(`确定删除「${dept.name}」？此操作不可撤销。`)) return;
    setDeleting(true);
    try {
      await fetch(
        `${BASE_PATH}/api/production/${dept.productionId}/departments/${dept.id}`,
        { method: "DELETE" }
      );
      onDeleted();
    } finally {
      setDeleting(false);
    }
  };

  const kindLabel = dept.kind === "dept" ? "部门" : "用户组";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {onMobileBack && (
        <div className="sm:hidden" style={{ padding: "8px 20px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
          <button onClick={onMobileBack} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}>
            ← 返回
          </button>
        </div>
      )}
      {/* Detail header */}
      <div style={{ padding: "20px 24px 14px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>
              {kindLabel}
            </p>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)", lineHeight: 1.2 }}>{dept.name}</h2>
            <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              {dept.memberUserIds.length} 位成员
              {dept.pocUserIds.length > 0 && `  ·  ${dept.pocUserIds.length} 位 POC`}
              {dept.chatId && (
                <span style={{ marginLeft: 8, color: "#2563eb", fontWeight: 500 }}>· 飞书群已创建</span>
              )}
            </p>
          </div>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              flexShrink: 0, fontSize: 12, color: "var(--muted)", background: "none",
              border: "1px solid var(--line)", borderRadius: 7, padding: "4px 10px",
              cursor: "pointer", transition: "color .1s, border-color .1s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#dc2626"; e.currentTarget.style.borderColor = "#dc2626"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--muted)"; e.currentTarget.style.borderColor = "var(--line)"; }}
          >
            {deleting ? "删除中…" : "删除"}
          </button>
        </div>

        {/* Search */}
        <div style={{ marginTop: 12, position: "relative" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索姓名或职位…"
            style={{
              width: "100%", boxSizing: "border-box",
              fontSize: 12, padding: "6px 10px 6px 28px",
              border: "1px solid var(--line)", borderRadius: 8, outline: "none",
              background: "var(--paper)", color: "var(--ink)",
            }}
          />
          <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "var(--muted)", pointerEvents: "none" }}>
            ⌕
          </span>
        </div>

        {/* Column labels */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingRight: 0 }}>
          <span style={{ flex: 1 }} />
          <span style={{ width: 40, fontSize: 10, fontWeight: 700, color: "var(--muted)", textAlign: "center", letterSpacing: ".04em" }}>成员</span>
          <span style={{ width: 40, fontSize: 10, fontWeight: 700, color: "#d97706", textAlign: "center", letterSpacing: ".04em" }}>POC</span>
        </div>
      </div>

      {/* Member list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
        {saving && (
          <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: "4px 0" }}>保存中…</div>
        )}
        {filtered.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "32px 0" }}>暂无匹配人员</p>
        ) : (
          filtered.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              isMember={memberSet.has(m.userId)}
              isPoc={pocSet.has(m.userId)}
              onToggleMember={() => toggleMember(m.userId)}
              onTogglePoc={() => togglePoc(m.userId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── TreeNode ─────────────────────────────────────────────────────────────────

function TreeNode({
  node,
  depth,
  selected,
  expanded,
  onSelect,
  onToggleExpand,
  onRename,
  onCreated,
}: {
  node: DeptNode;
  depth: number;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  onRename: (name: string) => void;
  onCreated: (dept: EventDepartment) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [creatingChild, setCreatingChild] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleRename = async (name: string) => {
    setRenaming(false);
    setSaving(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${node.productionId}/departments/${node.id}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }
      );
      const data = await res.json();
      if (data.department) onRename(data.department.name);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateChild = async (name: string) => {
    setCreatingChild(false);
    setSaving(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${node.productionId}/departments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, kind: node.kind }),
        }
      );
      const data = await res.json();
      if (data.department) onCreated(data.department);
    } finally {
      setSaving(false);
    }
  };

  const indentPx = depth * 20;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        onClick={onSelect}
        style={{
          display: "flex", alignItems: "center", gap: 0,
          padding: "0 8px 0 0",
          paddingLeft: 8 + indentPx,
          borderRadius: 8, cursor: "pointer",
          background: selected ? "var(--surface)" : "transparent",
          borderLeft: selected ? "3px solid var(--ink)" : "3px solid transparent",
          minHeight: 38,
          transition: "background .1s",
        }}
        onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(0,0,0,.04)"; }}
        onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
      >
        {/* Expand chevron — always reserve space */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          style={{
            width: 20, height: 20, border: "none", background: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            color: "var(--muted)", fontSize: 9, opacity: hasChildren ? 1 : 0.25,
          }}
        >
          {expanded ? "▼" : "▶"}
        </button>

        {/* Name */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
          {renaming ? (
            <InlineInput
              initial={node.name}
              placeholder="部门名称"
              onConfirm={handleRename}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <span
              style={{
                fontSize: 13, fontWeight: selected ? 600 : 500,
                color: saving ? "var(--muted)" : "var(--ink)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
              onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }}
            >
              {node.name}
            </span>
          )}
          {node.memberUserIds.length > 0 && !renaming && (
            <span style={{ flexShrink: 0, fontSize: 10, color: "var(--muted)", background: "var(--paper)", borderRadius: 10, padding: "0 5px", lineHeight: "18px" }}>
              {node.memberUserIds.length}
            </span>
          )}
          {node.chatId && !renaming && (
            <span style={{ flexShrink: 0, fontSize: 9, color: "#2563eb" }} title="飞书群已创建">群</span>
          )}
        </div>

        {/* Hover actions — 双击改名 / 点+新建子级 */}
        {!renaming && (
          <div
            className="dept-row-actions"
            style={{ display: "flex", gap: 2, flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setRenaming(true)}
              title="改名（双击名称也可改名）"
              style={{ fontSize: 10, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 4, lineHeight: 1 }}
            >
              改名
            </button>
          </div>
        )}
      </div>

      {/* Children (future hierarchy) */}
      {expanded && node.children.length > 0 && node.children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          selected={selected && false}
          expanded={false}
          onSelect={() => {}}
          onToggleExpand={() => {}}
          onRename={() => {}}
          onCreated={onCreated}
        />
      ))}

      {/* Inline child creation */}
      {creatingChild && (
        <div style={{ paddingLeft: 8 + indentPx + 20, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
          <InlineInput
            initial=""
            placeholder="子部门名称"
            onConfirm={handleCreateChild}
            onCancel={() => setCreatingChild(false)}
          />
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AdminDepartmentsClient({
  productionId,
  initialDepartments,
  members,
}: {
  productionId: string;
  initialDepartments: EventDepartment[];
  members: MemberWithRoles[];
}) {
  const [departments, setDepartments] = useState<EventDepartment[]>(initialDepartments);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<"dept" | "group" | null>(null);
  const [saving, setSaving] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

  const deptNodes = buildTree(departments.filter((d) => d.kind === "dept"));
  const groupNodes = buildTree(departments.filter((d) => d.kind === "group"));
  const selected = departments.find((d) => d.id === selectedId) ?? null;
  const selectedNode = selected ? { ...selected, parentId: null, children: [] } : null;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleCreate = async (name: string, kind: "dept" | "group") => {
    setCreating(null);
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/departments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind }),
      });
      const data = await res.json();
      if (data.department) {
        setDepartments((prev) => [...prev, data.department]);
        setSelectedId(data.department.id);
        setExpandedIds((prev) => new Set([...prev, data.department.id]));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUpdated = (updated: EventDepartment) => {
    setDepartments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  };

  const handleDeleted = (id: string) => {
    setDepartments((prev) => prev.filter((d) => d.id !== id));
    if (selectedId === id) { setSelectedId(null); setMobileView("list"); }
  };

  const renderGroup = (nodes: DeptNode[], kind: "dept" | "group") => {
    const label = kind === "dept" ? "部门" : "用户组";
    return (
      <div style={{ marginBottom: 4 }}>
        {/* Section header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 8px 4px" }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
            {label}
          </span>
          <button
            onClick={() => setCreating(kind)}
            title={`新建${label}`}
            style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px", lineHeight: 1 }}
          >
            +
          </button>
        </div>

        {/* Nodes */}
        {nodes.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            selected={selectedId === node.id}
            expanded={expandedIds.has(node.id)}
            onSelect={() => {
              setSelectedId(node.id);
              setExpandedIds((prev) => new Set([...prev, node.id]));
              setMobileView("detail");
            }}
            onToggleExpand={() => toggleExpand(node.id)}
            onRename={(name) => setDepartments((prev) => prev.map((d) => d.id === node.id ? { ...d, name } : d))}
            onCreated={(dept) => setDepartments((prev) => [...prev, dept])}
          />
        ))}

        {nodes.length === 0 && creating !== kind && (
          <p style={{ fontSize: 12, color: "var(--muted)", padding: "4px 28px" }}>暂无{label}</p>
        )}

        {/* Inline create row */}
        {creating === kind && (
          <div style={{ paddingLeft: 28, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
            <InlineInput
              initial=""
              placeholder={`${label}名称`}
              onConfirm={(name) => handleCreate(name, kind)}
              onCancel={() => setCreating(null)}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--paper)" }}>
      {/* Page header */}
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 0", flexShrink: 0 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", marginBottom: 4 }}>
          Admin · Departments
        </p>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", marginBottom: 20 }}>部门管理</h1>
      </div>

      {/* Body — tree + detail panel */}
      <div
        style={{
          flex: 1, minHeight: 0,
          display: "flex", gap: 0,
          padding: "0 clamp(18px, 3vw, 52px) 40px",
        }}
      >
        {/* Left: tree */}
        <div
          className={`${mobileView === "detail" ? "hidden sm:block" : ""} w-full sm:w-[240px] rounded-xl sm:rounded-r-none sm:!border-r-0 overflow-hidden`}
          style={{
            flexShrink: 0,
            background: "white",
            border: "1px solid var(--line)",
            overflowY: "auto", padding: "12px 8px",
          }}
        >
          {renderGroup(deptNodes, "dept")}

          <div style={{ height: 1, background: "var(--line)", margin: "12px 8px" }} />

          {renderGroup(groupNodes, "group")}
        </div>

        {/* Right: detail */}
        <div
          className={`${mobileView === "list" ? "hidden sm:flex sm:flex-col" : "flex flex-col"} rounded-xl sm:rounded-l-none`}
          style={{
            flex: 1, minWidth: 0,
            background: "white",
            border: "1px solid var(--line)",
            overflowY: "auto",
          }}
        >
          {selectedNode ? (
            <DeptDetail
              dept={selectedNode}
              members={members}
              onUpdated={handleUpdated}
              onDeleted={() => handleDeleted(selectedNode.id)}
              onMobileBack={() => setMobileView("list")}
            />
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
              ← 选择一个部门查看详情
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
