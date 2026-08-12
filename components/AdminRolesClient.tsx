"use client";

import { useState, useRef, useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { ProductionRole } from "@/lib/db";

// ─── Permission groups (excludes ROLE_TEMPLATE_EXCLUDED perms) ────────────────

type PermGroup = { label: string; perms: string[] };

const PERM_GROUPS: PermGroup[] = [
  {
    label: "成员管理",
    perms: ["members:invite", "members:kick", "members:change_role", "members:manage_overrides"],
  },
  {
    label: "部门管理",
    perms: [
      "dept:create", "dept:dismiss", "dept:rename", "dept:change_type",
      "dept:add_member", "dept:delete_member", "dept:set_poc", "dept:unset_poc",
    ],
  },
  {
    label: "项目配置",
    perms: ["production:manage_config", "production:mount", "production:unmount"],
  },
  {
    label: "里程碑",
    perms: ["milestone:create", "milestone:manage", "milestone:delete"],
  },
  {
    label: "通知公告",
    perms: ["announcement:create", "announcement:edit", "announcement:delete"],
  },
  {
    label: "剧本操作",
    perms: [
      "script:import", "script:manage", "script:edit", "script:annotate",
      "script:create_block", "script:delete_block", "script:edit_block",
      "script:set_character", "script:set_type", "script:set_tag", "script:reorder", "script:mount",
      "rehearsal_mark:create", "rehearsal_mark:edit", "rehearsal_mark:delete", "rehearsal_mark:move",
    ],
  },
  {
    label: "场次 & 构作",
    perms: [
      "scene:create", "scene:delete", "scene:rename", "scene:renumber", "scene:change_type",
      "scene:edit_synopsis", "scene:edit_action_line", "scene:edit_music",
      "scene:edit_stage_notes", "scene:edit_expected_duration", "scene:mount",
      "dramaturgy:import",
      "dramaturgy_view:create", "dramaturgy_view:delete", "dramaturgy_view:overwrite",
      "dramaturgy_view:create_public", "dramaturgy_view:delete_public", "dramaturgy_view:overwrite_public",
    ],
  },
  {
    label: "角色人物",
    perms: [
      "character:create", "character:rename", "character:change_type",
      "character:set_members", "character:edit_gender", "character:edit_biography",
      "character:edit_role_type", "character:delete",
    ],
  },
  {
    label: "报告",
    perms: [
      "report:create",
    ],
  },
  {
    label: "附件（个人）",
    perms: [
      "asset:create", "asset:rename", "asset:overwrite", "asset:change_type",
      "asset:delete", "asset:mount", "asset:unmount",
    ],
  },
  {
    label: "附件（管理 _any）",
    perms: [
      "asset:view_any", "asset:delete_any", "asset:rename_any",
      "asset:change_type_any", "asset:overwrite_any", "asset:mount_any", "asset:unmount_any",
    ],
  },
  {
    label: "标注体系",
    perms: [
      "tag_group:create", "tag_group:delete", "tag_group:rename", "tag_group:edit_range_config",
      "tag_group:set_default_option", "tag_group:set_lyric_split", "tag_group:reorder",
      "tag_option:create", "tag_option:delete", "tag_option:rename",
      "tag_option:edit_color", "tag_option:reorder",
    ],
  },
  {
    label: "评论管理",
    perms: [
      "script:edit_comment_any", "script:delete_comment_any",
      "report:edit_comment_any", "report:delete_comment_any",
    ],
  },
  {
    label: "读权限",
    perms: [
      "contacts:view",
      "script:view", "script:comment",
      "scene:view", "character:view",
      "report:reply",
      "asset:view", "asset:download", "asset:download_any",
      "asset:share", "asset:share_downloadable", "asset:share_any", "asset:share_any_downloadable",
      "org:assign_member", "org:recall_member",
    ],
  },
];

// ─── InlineInput ──────────────────────────────────────────────────────────────

function InlineInput({
  initial, placeholder, onConfirm, onCancel,
}: {
  initial: string; placeholder: string;
  onConfirm: (v: string) => void; onCancel: () => void;
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

// ─── PermissionGroup (collapsible, search-aware) ──────────────────────────────

function PermissionGroup({
  group, activePerms, onToggle, saving, searchQ,
}: {
  group: PermGroup; activePerms: Set<string>;
  onToggle: (perm: string) => void; saving: boolean; searchQ: string;
}) {
  const filtered = searchQ
    ? group.perms.filter((p) => p.toLowerCase().includes(searchQ))
    : group.perms;

  const [open, setOpen] = useState(false);

  // Auto-expand when search matches
  useEffect(() => { if (searchQ && filtered.length > 0) setOpen(true); }, [searchQ, filtered.length]);
  // Collapse when search cleared
  useEffect(() => { if (!searchQ) setOpen(false); }, [searchQ]);

  if (filtered.length === 0) return null;

  const activeCount = filtered.filter((p) => activePerms.has(p)).length;

  return (
    <div style={{ borderBottom: "1px solid var(--line)" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", background: "none", border: "none", cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{group.label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {activeCount > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700, background: "var(--ink)", color: "#fff",
              borderRadius: 10, padding: "1px 7px",
            }}>
              {activeCount}/{group.perms.length}
            </span>
          )}
          <span style={{ fontSize: 9, color: "var(--muted)", opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
        </span>
      </button>

      {open && (
        <div style={{ padding: "4px 16px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px" }}>
          {filtered.map((perm) => {
            const on = activePerms.has(perm);
            return (
              <label
                key={perm}
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "4px 0",
                  cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={saving}
                  onChange={() => onToggle(perm)}
                  style={{ width: 13, height: 13, cursor: "pointer", accentColor: "var(--ink)", flexShrink: 0 }}
                />
                <span style={{ fontSize: 11, color: "var(--ink)", fontFamily: "monospace", lineHeight: 1.3 }}>
                  {perm}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── RoleDetail (right panel) ─────────────────────────────────────────────────

function RoleDetail({
  role, productionId, onUpdated, onDeleted, onMobileBack,
}: {
  role: ProductionRole; productionId: string;
  onUpdated: (r: ProductionRole) => void; onDeleted: () => void;
  onMobileBack?: () => void;
}) {
  const [activePerms, setActivePerms] = useState<Set<string>>(() => new Set(role.permissions));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when a different role is selected.
  // key={role.id} on this component usually handles the remount;
  // this effect is a safety net in case the instance is reused.
  useEffect(() => {
    setActivePerms(new Set(role.permissions));
    setSearchQ("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.id]);

  const persistPermissions = async (perms: Set<string>) => {
    setSaving(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/roles/${role.id}/permissions`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissions: [...perms] }),
        },
      );
      const data = await res.json() as { permissions?: string[] };
      if (data.permissions) {
        const newPerms = new Set<string>(data.permissions);
        setActivePerms(newPerms);
        onUpdated({ ...role, permissions: [...newPerms] });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = (perm: string) => {
    const next = new Set(activePerms);
    if (next.has(perm)) next.delete(perm); else next.add(perm);
    setActivePerms(next);
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => persistPermissions(next), 400);
  };

  const handleDelete = async () => {
    if (!confirm(`确定删除角色「${role.name}」？\n已被分配该角色的成员会失去对应权限，此操作无法撤销。`)) return;
    setDeleting(true);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/roles/${role.id}`, { method: "DELETE" });
      onDeleted();
    } finally {
      setDeleting(false);
    }
  };

  const totalActive = PERM_GROUPS.reduce((n, g) => n + g.perms.filter((p) => activePerms.has(p)).length, 0);
  const q = searchQ.trim().toLowerCase();
  const noSearchResults = q && PERM_GROUPS.every((g) => g.perms.every((p) => !p.toLowerCase().includes(q)));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {onMobileBack && (
        <div className="sm:hidden" style={{ padding: "8px 20px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
          <button onClick={onMobileBack} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}>
            ← 返回
          </button>
        </div>
      )}
      {/* Header */}
      <div style={{ padding: "20px 24px 14px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>
              Role
            </p>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)" }}>{role.name}</h2>
            <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              {saving ? "保存中…" : `已启用 ${totalActive} 项权限`}
            </p>
          </div>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              flexShrink: 0, fontSize: 12, color: "var(--muted)", background: "none",
              border: "1px solid var(--line)", borderRadius: 7, padding: "4px 10px",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#dc2626"; e.currentTarget.style.borderColor = "#dc2626"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--muted)"; e.currentTarget.style.borderColor = "var(--line)"; }}
          >
            {deleting ? "删除中…" : "删除角色"}
          </button>
        </div>

        {/* Search */}
        <div style={{ marginTop: 12 }}>
          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="搜索权限（如 cue:create、script…）"
            style={{
              width: "100%", boxSizing: "border-box",
              fontSize: 12, color: "var(--ink)", background: "var(--paper)",
              border: "1px solid var(--line)", borderRadius: 8, padding: "6px 10px",
              outline: "none",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--ink)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--line)"; }}
          />
        </div>
      </div>

      {/* Permission groups */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {PERM_GROUPS.map((group) => (
          <PermissionGroup
            key={group.label}
            group={group}
            activePerms={activePerms}
            onToggle={handleToggle}
            saving={saving}
            searchQ={q}
          />
        ))}
        {noSearchResults && (
          <p style={{ padding: "16px", fontSize: 12, color: "var(--muted)" }}>
            未找到匹配「{q}」的权限
          </p>
        )}
      </div>
    </div>
  );
}

// ─── RoleRow (left panel item) ────────────────────────────────────────────────

function RoleRow({
  role, productionId, selected, onSelect, onRename, onCopy,
}: {
  role: ProductionRole; productionId: string; selected: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onCopy: (name: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [copying, setCopying] = useState(false);

  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "0 8px", minHeight: 38, borderRadius: 8, cursor: "pointer",
        background: selected ? "var(--surface)" : "transparent",
        borderLeft: selected ? "3px solid var(--ink)" : "3px solid transparent",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(0,0,0,.04)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      {renaming ? (
        <InlineInput
          initial={role.name}
          placeholder="角色名称"
          onConfirm={async (name) => {
            setRenaming(false);
            await fetch(`${BASE_PATH}/api/production/${productionId}/roles/${role.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            });
            onRename(name);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : copying ? (
        <InlineInput
          initial={`${role.name} (副本)`}
          placeholder="新角色名称"
          onConfirm={(name) => { setCopying(false); onCopy(name); }}
          onCancel={() => setCopying(false)}
        />
      ) : (
        <>
          <span
            style={{
              flex: 1, fontSize: 13, fontWeight: selected ? 600 : 500, color: "var(--ink)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
            onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }}
          >
            {role.name}
          </span>
          <span style={{
            flexShrink: 0, fontSize: 10, color: "var(--muted)",
            background: "var(--paper)", borderRadius: 10, padding: "0 5px", lineHeight: "18px",
          }}>
            {role.permissions.length}
          </span>
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 1, flexShrink: 0 }}>
            <button
              onClick={() => setRenaming(true)}
              title="改名"
              style={{ fontSize: 10, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "2px 3px", borderRadius: 4 }}
            >
              改名
            </button>
            <button
              onClick={() => setCopying(true)}
              title="复制角色"
              style={{ fontSize: 10, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "2px 3px", borderRadius: 4 }}
            >
              复制
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Roles that are managed outside this UI (special permission tiers)
const HIDDEN_ROLES = new Set(["制作人"]);

export default function AdminRolesClient({
  productionId,
  initialRoles,
}: {
  productionId: string;
  initialRoles: ProductionRole[];
}) {
  const [roles, setRoles] = useState<ProductionRole[]>(
    initialRoles.filter((r) => !HIDDEN_ROLES.has(r.name)),
  );
  const [selectedId, setSelectedId] = useState<string | null>(roles[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

  const selected = roles.find((r) => r.id === selectedId) ?? null;

  const handleCreate = async (name: string) => {
    setCreating(false);
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json() as { role?: ProductionRole };
      if (data.role) {
        setRoles((prev) => [...prev, data.role!]);
        setSelectedId(data.role!.id);
      }
    } finally { setSaving(false); }
  };

  const handleCopy = async (sourceId: string, newName: string) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/roles/${sourceId}/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const data = await res.json() as { role?: ProductionRole };
      if (data.role) {
        setRoles((prev) => [...prev, data.role!]);
        setSelectedId(data.role!.id);
      }
    } finally { setSaving(false); }
  };

  const handleDeleted = (id: string) => {
    setRoles((prev) => {
      const next = prev.filter((r) => r.id !== id);
      setSelectedId((cur) => {
        if (cur === id) { setMobileView("list"); return next[0]?.id ?? null; }
        return cur;
      });
      return next;
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--paper)" }}>
      {/* Page header */}
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 0", flexShrink: 0 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", marginBottom: 4 }}>
          Admin · Roles
        </p>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", marginBottom: 20 }}>角色管理</h1>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", padding: "0 clamp(18px, 3vw, 52px) 40px" }}>
        {/* Left: role list */}
        <div
          className={`${mobileView === "detail" ? "hidden sm:flex sm:flex-col" : "flex flex-col"} w-full sm:w-[220px] rounded-xl sm:rounded-r-none sm:!border-r-0 overflow-hidden`}
          style={{
            flexShrink: 0,
            background: "white",
            border: "1px solid var(--line)",
          }}
        >
          {/* List header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 12px 6px", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)" }}>
              角色 ({roles.length})
            </span>
            <button
              onClick={() => setCreating(true)}
              disabled={saving}
              style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
            >
              + 新建
            </button>
          </div>

          {/* Inline create */}
          {creating && (
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
              <InlineInput
                initial=""
                placeholder="角色名称"
                onConfirm={handleCreate}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}

          {/* Role rows */}
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px 8px" }}>
            {roles.length === 0 && !creating && (
              <p style={{ fontSize: 12, color: "var(--muted)", padding: "8px 4px" }}>暂无角色</p>
            )}
            {roles.map((role) => (
              <RoleRow
                key={role.id}
                role={role}
                productionId={productionId}
                selected={selectedId === role.id}
                onSelect={() => { setSelectedId(role.id); setMobileView("detail"); }}
                onRename={(name) => setRoles((prev) => prev.map((r) => r.id === role.id ? { ...r, name } : r))}
                onCopy={(name) => handleCopy(role.id, name)}
              />
            ))}
          </div>
        </div>

        {/* Right: detail */}
        <div
          className={`${mobileView === "list" ? "hidden sm:flex sm:flex-col" : "flex flex-col"} rounded-xl sm:rounded-l-none`}
          style={{
            flex: 1, minWidth: 0,
            background: "white",
            border: "1px solid var(--line)",
          }}
        >
          {selected ? (
            <RoleDetail
              key={selected.id}
              role={selected}
              productionId={productionId}
              onUpdated={(updated) => setRoles((prev) => prev.map((r) => r.id === updated.id ? updated : r))}
              onDeleted={() => handleDeleted(selected.id)}
              onMobileBack={() => setMobileView("list")}
            />
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
              ← 选择一个角色查看权限
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
