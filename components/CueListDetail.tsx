"use client";

import React, { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { CueList, CueListPermissionRow } from "@/lib/cue-list-types";
import type { MemberWithRoles } from "@/lib/db";

type Props = {
  productionId: string;
  cueList: CueList;
  permissions: CueListPermissionRow[];
  members: MemberWithRoles[];
  roleEditorUserIds: string[];
  canEdit: boolean;
  canManage: boolean;
  myUserId: string;
  onUpdated: (updated: Partial<CueList>) => void;
  onDeleted: () => void;
  onClose: () => void;
};

function MetaField({
  label,
  labelHint,
  value,
  canEdit,
  multiline,
  mono,
  transform,
  maxLength,
  onSave,
}: {
  label: string;
  labelHint?: React.ReactNode;
  value: string;
  canEdit: boolean;
  multiline?: boolean;
  mono?: boolean;
  transform?: (v: string) => string;
  maxLength?: number;
  onSave: (v: string) => Promise<string | void>;
}) {
  const [draft, setDraft] = useState(value);
  const [lastSeen, setLastSeen] = useState(value);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState("");

  if (lastSeen !== value) { setLastSeen(value); setDraft(value); setFieldError(""); }

  const commit = async () => {
    const committed = draft.trim();
    if (committed === value.trim()) return;
    setSaving(true);
    setFieldError("");
    try {
      const err = await onSave(committed);
      if (err) setFieldError(err);
    } finally { setSaving(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", borderRadius: 6, border: "1px solid var(--line)",
    padding: "5px 8px", fontSize: 12, outline: "none",
    background: "var(--surface)", color: "var(--ink)",
    fontFamily: mono ? "monospace" : undefined,
    opacity: saving ? 0.5 : 1,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
        {label}
        {labelHint && <span style={{ marginLeft: 4, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{labelHint}</span>}
      </label>
      {canEdit ? (
        multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            disabled={saving}
            rows={3}
            style={{ ...inputStyle, resize: "none" }}
            placeholder="—"
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(transform ? transform(e.target.value) : e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            disabled={saving}
            maxLength={maxLength}
            style={inputStyle}
            placeholder="—"
          />
        )
      ) : (
        <p style={{ fontSize: 12, color: "var(--ink)", whiteSpace: "pre-wrap", minHeight: "1.25rem" }}>
          {value || <span style={{ color: "var(--muted)", fontStyle: "italic" }}>—</span>}
        </p>
      )}
      {fieldError && <p style={{ fontSize: 10, color: "#dc2626" }}>{fieldError}</p>}
    </div>
  );
}

type PermState = "allow" | "deny" | "default";

function memberPermState(userId: string, permissions: CueListPermissionRow[]): PermState {
  const row = permissions.find((p) => p.userId === userId);
  if (!row) return "default";
  return row.canEdit ? "allow" : "deny";
}

function PermissionRow({
  member, state, cueListId, productionId, isDefaultEditor, onUpdated,
}: {
  member: MemberWithRoles;
  state: PermState;
  cueListId: string;
  productionId: string;
  isDefaultEditor: boolean;
  onUpdated: (permissions: CueListPermissionRow[]) => void;
}) {
  const [saving, setSaving] = useState(false);

  const setTo = async (next: PermState) => {
    if (next === state) return;
    setSaving(true);
    try {
      const canEdit: boolean | null = next === "allow" ? true : next === "deny" ? false : null;
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${cueListId}/permissions`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: member.userId, canEdit }) }
      );
      if (res.ok) onUpdated(await res.json() as CueListPermissionRow[]);
    } finally { setSaving(false); }
  };

  const PERM_LABELS: Record<PermState, string> = { allow: "允许", default: "默认", deny: "禁止" };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {member.name}
        </p>
        {member.roles.length > 0 && (
          <p style={{ fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {member.roles.join("、")}
          </p>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {(["allow", "default", "deny"] as PermState[]).map((s) => {
          const isActive = state === s;
          const activeColor = s === "allow" ? "#059669" : s === "deny" ? "#dc2626" : "var(--ink)";
          return (
            <button
              key={s}
              onClick={() => setTo(s)}
              disabled={saving}
              title={s === "default" ? (isDefaultEditor ? "默认：可编辑" : "默认：只读") : undefined}
              style={{
                borderRadius: 5, padding: "2px 8px", fontSize: 10, border: "none", cursor: saving ? "default" : "pointer",
                background: isActive ? activeColor : "var(--surface-2)",
                color: isActive ? "#fff" : "var(--muted)",
                opacity: saving ? 0.5 : 1,
                transition: "background .1s, color .1s",
              }}
            >
              {PERM_LABELS[s]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function CueListDetail({
  productionId, cueList: initialCueList, permissions: initialPermissions,
  members, roleEditorUserIds, canEdit, canManage,
  onUpdated, onDeleted, onClose,
}: Props) {
  const [cueList, setCueList] = useState(initialCueList);
  const [permissions, setPermissions] = useState(initialPermissions);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const patch = async (fields: { name?: string; notes?: string; abbr?: string | null }): Promise<string | void> => {
    const res = await fetch(
      `${BASE_PATH}/api/production/${productionId}/cuelists/${cueList.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) }
    );
    if (res.ok) {
      const updated = { ...cueList, ...fields };
      setCueList(updated);
      onUpdated(fields);
      return;
    }
    if (res.status === 409) return "简称已被同项目其他Cue表使用";
    const j = await res.json() as { error?: string };
    return j.error ?? "保存失败";
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${cueList.id}`,
        { method: "DELETE" }
      );
      if (res.ok) onDeleted();
    } finally { setDeleting(false); }
  };

  const editableMembers = members.filter((m) => m.userId !== cueList.createdBy);

  const sectionStyle: React.CSSProperties = {
    borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface)",
    padding: "16px", display: "flex", flexDirection: "column", gap: 12,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Drawer header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 20px", borderBottom: "1px solid var(--line)", flexShrink: 0,
      }}>
        <div>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 2 }}>
            Cue 表
          </p>
          <h2 style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>{cueList.name}</h2>
        </div>
        <button
          onClick={onClose}
          style={{
            border: 0, background: "transparent", fontSize: 18, cursor: "pointer",
            color: "var(--muted)", width: 32, height: 32, display: "flex",
            alignItems: "center", justifyContent: "center", borderRadius: 8,
          }}
          aria-label="关闭"
        >
          ×
        </button>
      </div>

      {/* Drawer body */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Meta */}
        <div style={sectionStyle}>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <MetaField label="名称" value={cueList.name} canEdit={canEdit} onSave={(v) => patch({ name: v })} />
            </div>
            <div style={{ width: 72, flexShrink: 0 }}>
              <MetaField
                label="简称"
                labelHint={<span style={{ color: "var(--muted)", fontSize: 9 }}>可选</span>}
                value={cueList.abbr ?? ""} canEdit={canEdit} mono
                transform={(v) => v.toUpperCase()} maxLength={8}
                onSave={(v) => patch({ abbr: v || null })}
              />
            </div>
          </div>
          <MetaField label="备注" value={cueList.notes} canEdit={canEdit} multiline onSave={(v) => patch({ notes: v })} />
          <div style={{ display: "flex", gap: 20 }}>
            {cueList.template && (
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 2 }}>类型</p>
                <p style={{ fontSize: 12, color: "var(--ink)" }}>{cueList.template}</p>
              </div>
            )}
            <div>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 2 }}>创建者</p>
              <p style={{ fontSize: 12, color: "var(--ink)" }}>{cueList.createdByName}</p>
            </div>
          </div>
        </div>

        {/* Permissions */}
        {canManage && (
          <div style={sectionStyle}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>编辑权限</p>
            {editableMembers.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>暂无其他成员</p>
            ) : (
              <div>
                {editableMembers.map((m) => (
                  <PermissionRow
                    key={m.userId}
                    member={m}
                    state={memberPermState(m.userId, permissions)}
                    cueListId={cueList.id}
                    productionId={productionId}
                    isDefaultEditor={roleEditorUserIds.includes(m.userId)}
                    onUpdated={setPermissions}
                  />
                ))}
              </div>
            )}
            <p style={{ fontSize: 10, color: "var(--muted)" }}>
              「默认」按角色默认编辑权限；「允许」强制赋予；「禁止」强制剥夺。
            </p>
          </div>
        )}

        {/* Delete */}
        {canManage && (
          <div style={sectionStyle}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>危险操作</p>
            {confirmDelete ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ fontSize: 12, color: "var(--ink)" }}>确认删除「{cueList.name}」？此操作不可撤销。</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    style={{ flex: 1, borderRadius: 8, border: "1px solid var(--line)", padding: "7px", fontSize: 12, cursor: "pointer", background: "transparent", color: "var(--muted)" }}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    style={{ flex: 1, borderRadius: 8, border: "none", padding: "7px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#dc2626", color: "#fff", opacity: deleting ? 0.5 : 1 }}
                  >
                    {deleting ? "删除中…" : "确认删除"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                style={{ border: 0, background: "transparent", fontSize: 12, color: "#ef4444", cursor: "pointer", textAlign: "left", padding: 0 }}
              >
                删除此 Cue 表
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
