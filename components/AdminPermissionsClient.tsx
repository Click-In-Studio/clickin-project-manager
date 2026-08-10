"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { ROLE_TEMPLATE_PERMISSIONS } from "@/lib/permissions";
import type { MemberWithRoles } from "@/lib/db";

// ─── Re-use same permission group definitions as AdminRolesClient ─────────────

type PermGroup = { label: string; perms: string[] };

const PERM_GROUPS: PermGroup[] = [
  { label: "成员管理", perms: ["members:invite", "members:kick", "members:change_role", "members:manage_overrides"] },
  { label: "部门管理", perms: ["dept:create", "dept:dismiss", "dept:rename", "dept:change_type", "dept:add_member", "dept:delete_member", "dept:set_poc", "dept:unset_poc"] },
  { label: "项目配置", perms: ["production:rename", "production:archive", "production:manage_config", "production:mount", "production:unmount", "production:change_avatar", "production:edit_description", "production:change_type", "production:change_language"] },
  { label: "里程碑", perms: ["milestone:create", "milestone:manage", "milestone:delete"] },
  { label: "通知公告", perms: ["announcement:create", "announcement:edit", "announcement:delete"] },
  { label: "剧本操作", perms: ["script:import", "script:manage", "script:edit", "script:annotate", "script:create_block", "script:delete_block", "script:edit_block", "script:set_character", "script:set_type", "script:set_tag", "script:reorder", "script:mount", "rehearsal_mark:create", "rehearsal_mark:edit", "rehearsal_mark:delete", "rehearsal_mark:move"] },
  { label: "场次 & 构作", perms: ["scene:create", "scene:delete", "scene:rename", "scene:renumber", "scene:change_type", "scene:edit_synopsis", "scene:edit_action_line", "scene:edit_music", "scene:edit_stage_notes", "scene:edit_expected_duration", "scene:mount", "dramaturgy:import", "dramaturgy_view:create", "dramaturgy_view:delete", "dramaturgy_view:overwrite", "dramaturgy_view:create_public", "dramaturgy_view:delete_public", "dramaturgy_view:overwrite_public"] },
  { label: "角色人物", perms: ["character:create", "character:rename", "character:change_type", "character:set_members", "character:edit_gender", "character:edit_biography", "character:edit_role_type", "character:delete"] },
  { label: "Cue 表（个人）", perms: ["cue_list:create", "cue_list:delete", "cue_list:rename", "cue_list:reorder", "cue_list:edit_abbr", "cue_list:edit_description", "cue_list:manage_permissions", "cue:create", "cue:delete", "cue:renumber", "cue:rename", "cue:edit_description", "cue:move", "cue:mount"] },
  { label: "Cue 表（管理 _any）", perms: ["cue_list:create_any", "cue_list:delete_any", "cue_list:rename_any", "cue_list:reorder_any", "cue_list:edit_abbr_any", "cue_list:edit_description_any", "cue_list:manage_permissions_any", "cue:create_any", "cue:delete_any", "cue:renumber_any", "cue:rename_any", "cue:edit_description_any", "cue:move_any", "cue:mount_any"] },
  { label: "事件 & 日程", perms: ["event:create", "event:view_call_sheet_any", "event:follow"] },
  { label: "任务", perms: ["task:view", "task:view_any", "task:delete_any"] },
  { label: "报告", perms: ["report:create"] },
  { label: "附件（个人）", perms: ["asset:create", "asset:rename", "asset:overwrite", "asset:change_type", "asset:delete", "asset:mount", "asset:unmount"] },
  { label: "附件（管理 _any）", perms: ["asset:view_any", "asset:delete_any", "asset:rename_any", "asset:change_type_any", "asset:overwrite_any", "asset:mount_any", "asset:unmount_any"] },
  { label: "标注体系", perms: ["tag_group:create", "tag_group:delete", "tag_group:rename", "tag_group:edit_range_config", "tag_group:set_default_option", "tag_group:set_lyric_split", "tag_group:reorder", "tag_option:create", "tag_option:delete", "tag_option:rename", "tag_option:edit_color", "tag_option:reorder"] },
  { label: "评论管理", perms: ["script:edit_comment_any", "script:delete_comment_any", "cue:edit_comment_any", "cue:delete_comment_any", "report:edit_comment_any", "report:delete_comment_any"] },
  { label: "读权限", perms: ["contacts:view", "script:view", "script:comment", "scene:view", "character:view", "cue_list:view", "cue:view", "cue:comment", "event:view_call_sheet_any", "event:follow", "report:reply", "asset:view", "asset:download", "asset:download_any", "asset:share", "asset:share_downloadable", "asset:share_any", "asset:share_any_downloadable", "org:assign_member", "org:recall_member"] },
];

// ─── Types ────────────────────────────────────────────────────────────────────

type Overrides = Record<string, Record<string, boolean>>; // userId → permKey → granted

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rolePermsForMember(roles: string[]): Set<string> {
  const s = new Set<string>();
  for (const role of roles) {
    for (const p of ROLE_TEMPLATE_PERMISSIONS[role] ?? []) s.add(p);
  }
  return s;
}

function overrideCountForMember(userId: string, overrides: Overrides): number {
  return Object.keys(overrides[userId] ?? {}).length;
}

// ─── PermGroup row for single-member detail ───────────────────────────────────

function SinglePermGroup({
  group, rolePerms, memberOverrides, onOverride, saving, searchQ,
}: {
  group: PermGroup;
  rolePerms: Set<string>;
  memberOverrides: Record<string, boolean>;
  onOverride: (perm: string, granted: boolean | null) => void;
  saving: boolean;
  searchQ: string;
}) {
  const filtered = searchQ ? group.perms.filter((p) => p.toLowerCase().includes(searchQ)) : group.perms;
  const [open, setOpen] = useState(false);
  useEffect(() => { if (searchQ && filtered.length > 0) setOpen(true); }, [searchQ, filtered.length]);
  useEffect(() => { if (!searchQ) setOpen(false); }, [searchQ]);
  if (filtered.length === 0) return null;

  const grantCount = filtered.filter((p) => memberOverrides[p] === true).length;
  const denyCount = filtered.filter((p) => memberOverrides[p] === false).length;

  return (
    <div style={{ borderBottom: "1px solid var(--line)" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{group.label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {grantCount > 0 && <span style={{ fontSize: 10, fontWeight: 700, background: "#16a34a", color: "#fff", borderRadius: 10, padding: "1px 6px" }}>+{grantCount}</span>}
          {denyCount > 0 && <span style={{ fontSize: 10, fontWeight: 700, background: "#dc2626", color: "#fff", borderRadius: 10, padding: "1px 6px" }}>−{denyCount}</span>}
          <span style={{ fontSize: 9, color: "var(--muted)", opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: "2px 16px 10px" }}>
          {filtered.map((perm) => {
            const fromRole = rolePerms.has(perm);
            const ov = memberOverrides[perm]; // true | false | undefined
            return (
              <div key={perm} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                {/* Role baseline indicator */}
                <span style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0, background: fromRole ? "#bbf7d0" : "var(--line)", border: fromRole ? "1px solid #4ade80" : "1px solid var(--line)" }} title={fromRole ? "角色已包含" : "角色不包含"} />
                <span style={{ flex: 1, fontSize: 11, fontFamily: "monospace", color: "var(--ink)" }}>{perm}</span>
                {/* 3-state control: grant / clear / deny */}
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  <button
                    disabled={saving}
                    onClick={() => onOverride(perm, ov === true ? null : true)}
                    title="授予 override"
                    style={{ fontSize: 11, padding: "1px 6px", borderRadius: 5, border: "1px solid", cursor: "pointer", transition: "all .1s", background: ov === true ? "#16a34a" : "transparent", borderColor: ov === true ? "#16a34a" : "var(--line)", color: ov === true ? "#fff" : "var(--muted)" }}
                  >
                    ✓
                  </button>
                  <button
                    disabled={saving}
                    onClick={() => onOverride(perm, ov === false ? null : false)}
                    title="拒绝 override"
                    style={{ fontSize: 11, padding: "1px 6px", borderRadius: 5, border: "1px solid", cursor: "pointer", transition: "all .1s", background: ov === false ? "#dc2626" : "transparent", borderColor: ov === false ? "#dc2626" : "var(--line)", color: ov === false ? "#fff" : "var(--muted)" }}
                  >
                    ✗
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Single-member right panel ────────────────────────────────────────────────

function MemberDetail({
  member, productionId, overrides, onOverrideChange, onMobileBack,
}: {
  member: MemberWithRoles;
  productionId: string;
  overrides: Overrides;
  onOverrideChange: (userId: string, perm: string, granted: boolean | null) => void;
  onMobileBack?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const memberOverrides = overrides[member.userId] ?? {};
  const rolePerms = useMemo(() => rolePermsForMember(member.roles), [member.roles]);
  const overrideCount = Object.keys(memberOverrides).length;
  const grantCount = Object.values(memberOverrides).filter(Boolean).length;
  const denyCount = Object.values(memberOverrides).filter((v) => !v).length;
  const q = searchQ.trim().toLowerCase();

  const handleOverride = async (perm: string, granted: boolean | null) => {
    setSaving(true);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/permissions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: member.userId, permission: perm, granted }),
      });
      onOverrideChange(member.userId, perm, granted);
    } finally {
      setSaving(false);
    }
  };

  const handleClearAll = async () => {
    if (!confirm(`清除「${member.name}」的所有个人 override（${overrideCount} 条）？`)) return;
    setSaving(true);
    try {
      for (const perm of Object.keys(memberOverrides)) {
        await fetch(`${BASE_PATH}/api/production/${productionId}/permissions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: member.userId, permission: perm, granted: null }),
        });
        onOverrideChange(member.userId, perm, null);
      }
    } finally {
      setSaving(false);
    }
  };

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
      <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 3 }}>个人 Override</p>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>{member.name}</h2>
            <div style={{ marginTop: 5, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {member.roles.map((r) => (
                <span key={r} style={{ fontSize: 10, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 6, padding: "1px 6px", color: "var(--muted)" }}>{r}</span>
              ))}
            </div>
            {overrideCount > 0 && (
              <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
                {saving ? "保存中…" : <>
                  {grantCount > 0 && <span style={{ color: "#16a34a", marginRight: 6 }}>+{grantCount} 授予</span>}
                  {denyCount > 0 && <span style={{ color: "#dc2626" }}>−{denyCount} 拒绝</span>}
                </>}
              </p>
            )}
            {overrideCount === 0 && <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>无个人 override</p>}
          </div>
          {overrideCount > 0 && (
            <button
              onClick={handleClearAll}
              disabled={saving}
              style={{ flexShrink: 0, fontSize: 11, color: "var(--muted)", background: "none", border: "1px solid var(--line)", borderRadius: 7, padding: "3px 8px", cursor: "pointer" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#dc2626"; e.currentTarget.style.borderColor = "#dc2626"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--muted)"; e.currentTarget.style.borderColor = "var(--line)"; }}
            >
              清除全部
            </button>
          )}
        </div>

        {/* Legend */}
        <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--muted)" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#bbf7d0", border: "1px solid #4ade80", display: "inline-block" }} />
            角色包含
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--muted)" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--line)", border: "1px solid var(--line)", display: "inline-block" }} />
            角色不包含
          </span>
          <span style={{ fontSize: 10, color: "#16a34a" }}>✓ 授予 override</span>
          <span style={{ fontSize: 10, color: "#dc2626" }}>✗ 拒绝 override</span>
        </div>

        {/* Search */}
        <div style={{ marginTop: 10 }}>
          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="搜索权限（如 cue:create、script…）"
            style={{ width: "100%", boxSizing: "border-box", fontSize: 12, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8, padding: "5px 10px", outline: "none" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--ink)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--line)"; }}
          />
        </div>
      </div>

      {/* Permission groups */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {PERM_GROUPS.map((group) => (
          <SinglePermGroup
            key={group.label}
            group={group}
            rolePerms={rolePerms}
            memberOverrides={memberOverrides}
            onOverride={handleOverride}
            saving={saving}
            searchQ={q}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Bulk panel ───────────────────────────────────────────────────────────────

function BulkPanel({
  selectedIds, members, productionId, overrides, onOverrideChange, onMobileBack,
}: {
  selectedIds: string[];
  members: MemberWithRoles[];
  productionId: string;
  overrides: Overrides;
  onOverrideChange: (userId: string, perm: string, granted: boolean | null) => void;
  onMobileBack?: () => void;
}) {
  const [searchQ, setSearchQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastOp, setLastOp] = useState<string | null>(null);
  const q = searchQ.trim().toLowerCase();
  const selected = members.filter((m) => selectedIds.includes(m.userId));

  const applyBulk = async (perm: string, granted: boolean | null) => {
    setSaving(true);
    setLastOp(null);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: selectedIds, permission: perm, granted }),
      });
      for (const userId of selectedIds) onOverrideChange(userId, perm, granted);
      setLastOp(`已对 ${selectedIds.length} 人 ${granted === null ? "清除" : granted ? "授予" : "拒绝"} ${perm}`);
    } finally {
      setSaving(false);
    }
  };

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
      <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 3 }}>批量操作</p>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>已选 {selectedIds.length} 人</h2>
        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
          {selected.map((m) => (
            <span key={m.userId} style={{ fontSize: 10, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 6, padding: "1px 6px", color: "var(--ink)" }}>{m.name}</span>
          ))}
        </div>
        {lastOp && <p style={{ fontSize: 11, color: "#16a34a", marginTop: 6 }}>{lastOp}</p>}
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>点击下方权限行右侧按钮，对所有选中成员应用同一 override。</p>
        <div style={{ marginTop: 10 }}>
          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="搜索权限…"
            style={{ width: "100%", boxSizing: "border-box", fontSize: 12, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8, padding: "5px 10px", outline: "none" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--ink)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--line)"; }}
          />
        </div>
      </div>

      {/* Bulk permission list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {PERM_GROUPS.map((group) => {
          const filtered = q ? group.perms.filter((p) => p.toLowerCase().includes(q)) : group.perms;
          if (filtered.length === 0) return null;
          return (
            <div key={group.label} style={{ borderBottom: "1px solid var(--line)" }}>
              <div style={{ padding: "8px 16px 4px", fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".06em", textTransform: "uppercase" }}>
                {group.label}
              </div>
              {filtered.map((perm) => (
                <div key={perm} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 16px" }}>
                  <span style={{ flex: 1, fontSize: 11, fontFamily: "monospace", color: "var(--ink)" }}>{perm}</span>
                  <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                    <button disabled={saving} onClick={() => applyBulk(perm, true)} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, border: "1px solid #16a34a", color: "#16a34a", background: "none", cursor: "pointer" }}>批量授予</button>
                    <button disabled={saving} onClick={() => applyBulk(perm, false)} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, border: "1px solid #dc2626", color: "#dc2626", background: "none", cursor: "pointer" }}>批量拒绝</button>
                    <button disabled={saving} onClick={() => applyBulk(perm, null)} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, border: "1px solid var(--line)", color: "var(--muted)", background: "none", cursor: "pointer" }}>清除</button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Left panel: member list ──────────────────────────────────────────────────

function MemberList({
  members, overrides, selectedIds, onSelect, onToggleCheck, onGoToBulk,
}: {
  members: MemberWithRoles[];
  overrides: Overrides;
  selectedIds: string[];
  onSelect: (userId: string) => void;
  onToggleCheck: (userId: string) => void;
  onGoToBulk: () => void;
}) {
  const [nameQ, setNameQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");

  // Build "role [tag]" combined filter options
  const allRoleFilters = useMemo(() => {
    const s = new Set<string>();
    for (const m of members) {
      for (const r of m.roles) {
        if (m.tags.length === 0) {
          s.add(r);
        } else {
          for (const t of m.tags) s.add(`${r} [${t}]`);
        }
      }
    }
    return [...s].sort();
  }, [members]);

  const filtered = useMemo(() => {
    const q = nameQ.trim().toLowerCase();
    return members.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q)) return false;
      if (roleFilter) {
        const combined = roleFilter.match(/^(.+) \[(.+)\]$/);
        if (combined) {
          const [, role, tag] = combined;
          if (!m.roles.includes(role) || !m.tags.includes(tag)) return false;
        } else {
          if (!m.roles.includes(roleFilter)) return false;
        }
      }
      return true;
    });
  }, [members, nameQ, roleFilter]);

  const activeSingle = selectedIds.length === 1 ? selectedIds[0] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Filters */}
      <div style={{ padding: "10px 10px 6px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <input
          type="search"
          value={nameQ}
          onChange={(e) => setNameQ(e.target.value)}
          placeholder="搜索姓名…"
          style={{ width: "100%", boxSizing: "border-box", fontSize: 12, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 7, padding: "5px 8px", outline: "none", color: "var(--ink)" }}
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          style={{ width: "100%", marginTop: 5, fontSize: 12, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 7, padding: "5px 8px", outline: "none", color: "var(--muted)", boxSizing: "border-box" }}
        >
          <option value="">全部角色</option>
          {allRoleFilters.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      {/* Bulk hint (desktop only) */}
      {selectedIds.length > 1 && (
        <div className="hidden sm:block" style={{ padding: "5px 10px", fontSize: 10, background: "#fef9c3", color: "#854d0e", borderBottom: "1px solid #fde68a" }}>
          已选 {selectedIds.length} 人 — 右侧可批量操作
        </div>
      )}

      {/* Member rows (grows, scrollable) */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
        {filtered.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)", padding: "8px 4px" }}>无匹配成员</p>}
        {filtered.map((m) => {
          const isActive = activeSingle === m.userId;
          const isChecked = selectedIds.includes(m.userId);
          const ovCount = overrideCountForMember(m.userId, overrides);
          return (
            <div
              key={m.userId}
              onClick={() => onSelect(m.userId)}
              style={{
                display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 6px", borderRadius: 8, cursor: "pointer",
                background: isActive ? "var(--surface)" : "transparent",
                borderLeft: isActive ? "3px solid var(--ink)" : "3px solid transparent",
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "rgba(0,0,0,.04)"; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={(e) => { e.stopPropagation(); onToggleCheck(m.userId); }}
                onClick={(e) => e.stopPropagation()}
                style={{ marginTop: 2, flexShrink: 0, cursor: "pointer", accentColor: "var(--ink)" }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: isActive ? 600 : 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.name}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 2 }}>
                  {m.roles.slice(0, 3).map((r) => (
                    <span key={r} style={{ fontSize: 9, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 4, padding: "0 4px", color: "var(--muted)", lineHeight: "16px" }}>{r}</span>
                  ))}
                  {m.roles.length > 3 && <span style={{ fontSize: 9, color: "var(--muted)" }}>+{m.roles.length - 3}</span>}
                  {m.tags.slice(0, 2).map((t) => (
                    <span key={t} style={{ fontSize: 9, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 4, padding: "0 4px", color: "var(--ink)", lineHeight: "16px", opacity: 0.7 }}>{t}</span>
                  ))}
                </div>
              </div>
              {ovCount > 0 && (
                <span style={{ flexShrink: 0, fontSize: 10, background: "var(--ink)", color: "#fff", borderRadius: 10, padding: "1px 5px", lineHeight: "16px", marginTop: 1 }}>
                  {ovCount}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Mobile: navigation button (always present, disabled when nothing selected) */}
      <div className="sm:hidden" style={{ padding: "10px 12px", borderTop: "1px solid var(--line)", flexShrink: 0 }}>
        <button
          onClick={onGoToBulk}
          disabled={selectedIds.length === 0}
          style={{
            width: "100%", padding: "10px", borderRadius: 10, border: "none",
            background: selectedIds.length === 0 ? "var(--line)" : "var(--ink)",
            color: selectedIds.length === 0 ? "var(--muted)" : "#fff",
            fontSize: 13, fontWeight: 700,
            cursor: selectedIds.length === 0 ? "default" : "pointer",
            transition: "background .15s, color .15s",
          }}
        >
          {selectedIds.length >= 2
            ? `批量修改权限（${selectedIds.length} 人）`
            : "修改权限"}
        </button>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AdminPermissionsClient({
  productionId,
  initialMembers,
  initialOverrides,
}: {
  productionId: string;
  initialMembers: MemberWithRoles[];
  initialOverrides: Overrides;
}) {
  const [members] = useState<MemberWithRoles[]>(initialMembers);
  const [overrides, setOverrides] = useState<Overrides>(initialOverrides);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    initialMembers.length > 0 ? [initialMembers[0].userId] : [],
  );
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

  const handleOverrideChange = (userId: string, perm: string, granted: boolean | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (granted === null) {
        const userOvs = { ...next[userId] };
        delete userOvs[perm];
        next[userId] = userOvs;
      } else {
        next[userId] = { ...next[userId], [perm]: granted };
      }
      return next;
    });
  };

  const handleSelect = (userId: string) => {
    setSelectedIds([userId]);
    // Desktop: right panel auto-updates. Mobile: user taps the bottom button to navigate.
  };

  const handleToggleCheck = (userId: string) => {
    setSelectedIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const handleGoToBulk = () => {
    setMobileView("detail");
  };

  const isBulk = selectedIds.length > 1;
  const singleMember = !isBulk && selectedIds.length === 1
    ? members.find((m) => m.userId === selectedIds[0])
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--paper)" }}>
      {/* Page header */}
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 0", flexShrink: 0 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", marginBottom: 4 }}>Admin · Permissions</p>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", marginBottom: 20 }}>人事权限</h1>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", padding: "0 clamp(18px, 3vw, 52px) 40px" }}>
        {/* Left: member list */}
        <div
          className={`${mobileView === "detail" ? "hidden sm:flex sm:flex-col" : "flex flex-col"} w-full sm:w-[260px] rounded-xl sm:rounded-r-none sm:!border-r-0 overflow-hidden`}
          style={{ flexShrink: 0, background: "white", border: "1px solid var(--line)" }}
        >
          <div style={{ padding: "10px 10px 0", borderBottom: "none" }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)" }}>
              成员 ({members.length})
            </span>
          </div>
          <MemberList
            members={members}
            overrides={overrides}
            selectedIds={selectedIds}
            onSelect={handleSelect}
            onToggleCheck={handleToggleCheck}
            onGoToBulk={handleGoToBulk}
          />
        </div>

        {/* Right: detail / bulk */}
        <div
          className={`${mobileView === "list" ? "hidden sm:flex sm:flex-col" : "flex flex-col"} rounded-xl sm:rounded-l-none`}
          style={{ flex: 1, minWidth: 0, background: "white", border: "1px solid var(--line)" }}
        >
          {isBulk ? (
            <BulkPanel
              selectedIds={selectedIds}
              members={members}
              productionId={productionId}
              overrides={overrides}
              onOverrideChange={handleOverrideChange}
              onMobileBack={() => setMobileView("list")}
            />
          ) : singleMember ? (
            <MemberDetail
              key={singleMember.userId}
              member={singleMember}
              productionId={productionId}
              overrides={overrides}
              onOverrideChange={handleOverrideChange}
              onMobileBack={() => setMobileView("list")}
            />
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
              ← 选择一位成员查看 / 编辑权限
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
