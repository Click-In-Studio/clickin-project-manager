"use client";

import React, { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { CueList, CueListGrant, CueListDeptAccess } from "@/lib/cue-list-types";
import type { MemberWithRoles } from "@/lib/db";

type Props = {
  productionId: string;
  cueList: CueList;
  grants: CueListGrant[];
  deptAccess: CueListDeptAccess[];
  productionDepts: { id: string; name: string }[];
  members: MemberWithRoles[];
  canEdit: boolean;
  canManage: boolean;
  myUserId: string;
  onUpdated: (updated: Partial<CueList>) => void;
  onDeleted: () => void;
  onClose: () => void;
};

function MetaField({
  label, labelHint, value, canEdit, multiline, mono, transform, maxLength, onSave,
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
            value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            disabled={saving} rows={3} style={{ ...inputStyle, resize: "none" }} placeholder="—"
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(transform ? transform(e.target.value) : e.target.value)}
            onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            disabled={saving} maxLength={maxLength} style={inputStyle} placeholder="—"
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

const GRANT_LEVELS: { value: string; label: string }[] = [
  { value: "view",   label: "查看" },
  { value: "mount",  label: "挂载资产" },
  { value: "edit",   label: "编辑" },
  { value: "manage", label: "管理" },
];
const LEVEL_LABEL: Record<string, string> = Object.fromEntries(GRANT_LEVELS.map(l => [l.value, l.label]));

function CollaboratorSection({
  productionId, cueListId, initialGrants, initialDeptAccess, productionDepts, members, myUserId,
}: {
  productionId: string;
  cueListId: string;
  initialGrants: CueListGrant[];
  initialDeptAccess: CueListDeptAccess[];
  productionDepts: { id: string; name: string }[];
  members: MemberWithRoles[];
  myUserId: string;
}) {
  const [grants, setGrants] = useState(initialGrants);
  const [deptAccess, setDeptAccess] = useState(initialDeptAccess);
  const [saving, setSaving] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  const [showAddDept, setShowAddDept] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [pendingUser, setPendingUser] = useState<{ userId: string; name: string } | null>(null);

  const BASE = `${BASE_PATH}/api/production/${productionId}/cuelists/${cueListId}/collaborators`;

  const postCollaborator = async (body: object) => {
    setSaving(true);
    try {
      const res = await fetch(BASE, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json() as { grants: CueListGrant[]; deptAccess: CueListDeptAccess[] };
        setGrants(data.grants);
        setDeptAccess(data.deptAccess);
      }
    } finally { setSaving(false); }
  };

  const deleteCollaborator = async (body: object) => {
    setSaving(true);
    try {
      const res = await fetch(BASE, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json() as { grants: CueListGrant[]; deptAccess: CueListDeptAccess[] };
        setGrants(data.grants);
        setDeptAccess(data.deptAccess);
      }
    } finally { setSaving(false); }
  };

  const grantedUserIds = new Set(grants.map(g => g.userId));
  const addedDeptIds = new Set(deptAccess.map(d => d.deptId));
  const availableDepts = productionDepts.filter(d => !addedDeptIds.has(d.id));
  const availableMembers = members.filter(m =>
    !grantedUserIds.has(m.userId) &&
    (userSearch === "" || m.name.includes(userSearch))
  );

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8,
    padding: "7px 0", borderBottom: "1px solid var(--line)",
  };
  const removeBtn: React.CSSProperties = {
    marginLeft: "auto", flexShrink: 0, border: 0, background: "transparent",
    fontSize: 11, color: "var(--muted)", cursor: saving ? "default" : "pointer", padding: "2px 6px",
    borderRadius: 5,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
    textTransform: "uppercase", color: "var(--muted)", marginBottom: 6,
  };
  const addBtnStyle: React.CSSProperties = {
    border: "1px dashed var(--line)", background: "transparent", borderRadius: 7,
    padding: "5px 10px", fontSize: 11, color: "var(--muted)", cursor: "pointer", width: "100%",
    textAlign: "left" as const, marginTop: 4,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Dept access */}
      <div>
        <p style={labelStyle}>部门自助访问</p>
        {deptAccess.length === 0 && (
          <p style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", marginBottom: 4 }}>暂无部门</p>
        )}
        {deptAccess.map(d => (
          <div key={d.deptId} style={rowStyle}>
            <span style={{ fontSize: 12, color: "var(--ink)" }}>{d.deptName}</span>
            <button style={removeBtn} disabled={saving}
              onClick={() => deleteCollaborator({ type: "dept", deptId: d.deptId })}>
              移除
            </button>
          </div>
        ))}
        {!showAddDept && availableDepts.length > 0 && (
          <button style={addBtnStyle} onClick={() => setShowAddDept(true)}>+ 添加部门</button>
        )}
        {showAddDept && (
          <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
            {availableDepts.map(d => (
              <button key={d.id} disabled={saving}
                style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "6px 10px", fontSize: 12, background: "var(--surface-2)", color: "var(--ink)", cursor: saving ? "default" : "pointer", textAlign: "left" }}
                onClick={async () => {
                  await postCollaborator({ type: "dept", deptId: d.id });
                  setShowAddDept(false);
                }}>
                {d.name}
              </button>
            ))}
            <button style={{ ...addBtnStyle, marginTop: 2 }} onClick={() => setShowAddDept(false)}>取消</button>
          </div>
        )}
        <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 }}>
          添加部门后，该部门符合条件的成员可自助确认访问权限
        </p>
      </div>

      {/* Individual grants */}
      <div>
        <p style={labelStyle}>个人直接授权</p>
        {grants.length === 0 && (
          <p style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", marginBottom: 4 }}>暂无个人授权</p>
        )}
        {grants.map(g => (
          <div key={g.userId + g.level} style={rowStyle}>
            <span style={{ fontSize: 12, color: "var(--ink)", flex: 1, minWidth: 0 }}>{g.userName}</span>
            <select
              value={g.level}
              disabled={saving}
              onChange={async (e) => { await postCollaborator({ type: "user", userId: g.userId, level: e.target.value }); }}
              style={{ fontSize: 11, border: "1px solid var(--line)", borderRadius: 5, padding: "2px 4px", background: "var(--surface)", color: "var(--ink)", cursor: saving ? "default" : "pointer" }}>
              {GRANT_LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
            <button style={removeBtn} disabled={saving}
              onClick={() => deleteCollaborator({ type: "user", userId: g.userId })}>
              移除
            </button>
          </div>
        ))}
        {!showAddUser && (
          <button style={addBtnStyle} onClick={() => { setShowAddUser(true); setUserSearch(""); setPendingUser(null); }}>
            + 添加成员
          </button>
        )}
        {showAddUser && (
          <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
            {!pendingUser ? (
              <>
                <input
                  autoFocus placeholder="搜索姓名…" value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "6px 10px", fontSize: 12, outline: "none", background: "var(--surface)", color: "var(--ink)", marginBottom: 2 }}
                />
                {userSearch === "" ? (
                  <p style={{ fontSize: 11, color: "var(--muted)", padding: "4px 2px" }}>输入姓名搜索成员…</p>
                ) : availableMembers.length === 0 ? (
                  <p style={{ fontSize: 11, color: "var(--muted)", padding: "4px 2px" }}>无匹配成员</p>
                ) : availableMembers.map(m => (
                  <button key={m.userId} disabled={saving}
                    style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "6px 10px", fontSize: 12, background: "var(--surface-2)", color: "var(--ink)", cursor: saving ? "default" : "pointer", textAlign: "left" }}
                    onClick={() => { setPendingUser({ userId: m.userId, name: m.name }); }}>
                    <span>{m.name}</span>
                    {m.roles.length > 0 && <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{m.roles.slice(0, 2).join("、")}</span>}
                  </button>
                ))}
              </>
            ) : (
              <>
                <p style={{ fontSize: 12, color: "var(--ink)", padding: "4px 2px", fontWeight: 600 }}>
                  {pendingUser.name} — 选择权限
                </p>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const, marginBottom: 2 }}>
                  {GRANT_LEVELS.map(l => (
                    <button key={l.value} disabled={saving}
                      style={{ borderRadius: 6, border: "1px solid var(--line)", padding: "4px 12px", fontSize: 11, cursor: saving ? "default" : "pointer", background: "var(--surface-2)", color: "var(--ink)" }}
                      onClick={async () => {
                        await postCollaborator({ type: "user", userId: pendingUser.userId, level: l.value });
                        setShowAddUser(false); setUserSearch(""); setPendingUser(null);
                      }}>
                      {l.label}
                    </button>
                  ))}
                </div>
                <button style={{ ...addBtnStyle, marginTop: 0 }} onClick={() => setPendingUser(null)}>← 返回</button>
              </>
            )}
            <button style={{ ...addBtnStyle, marginTop: 2 }} onClick={() => { setShowAddUser(false); setUserSearch(""); setPendingUser(null); }}>取消</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CueListDetail({
  productionId, cueList: initialCueList, grants, deptAccess, productionDepts,
  members, canEdit, canManage, myUserId,
  onUpdated, onDeleted, onClose,
}: Props) {
  const [cueList, setCueList] = useState(initialCueList);
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
          style={{ border: 0, background: "transparent", fontSize: 18, cursor: "pointer", color: "var(--muted)", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8 }}
          aria-label="关闭"
        >×</button>
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
                label="简称" labelHint={<span style={{ color: "var(--muted)", fontSize: 9 }}>可选</span>}
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

        {/* Collaborators */}
        {canManage && (
          <div style={sectionStyle}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>协作者</p>
            <CollaboratorSection
              productionId={productionId}
              cueListId={cueList.id}
              initialGrants={grants}
              initialDeptAccess={deptAccess}
              productionDepts={productionDepts}
              members={members}
              myUserId={myUserId}
            />
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
                  <button onClick={() => setConfirmDelete(false)} disabled={deleting}
                    style={{ flex: 1, borderRadius: 8, border: "1px solid var(--line)", padding: "7px", fontSize: 12, cursor: "pointer", background: "transparent", color: "var(--muted)" }}>
                    取消
                  </button>
                  <button onClick={handleDelete} disabled={deleting}
                    style={{ flex: 1, borderRadius: 8, border: "none", padding: "7px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#dc2626", color: "#fff", opacity: deleting ? 0.5 : 1 }}>
                    {deleting ? "删除中…" : "确认删除"}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)}
                style={{ border: 0, background: "transparent", fontSize: 12, color: "#ef4444", cursor: "pointer", textAlign: "left", padding: 0 }}>
                删除此 Cue 表
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
