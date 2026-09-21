"use client";

import React, { useState, useEffect } from "react";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";
import { fetchCueListCollaborators, addCueListCollaborator, removeCueListCollaborator } from "@/lib/ops/cue-client";
import type { MemberWithRoles } from "@/lib/perm/member-db";
import type { CueListGrant, CueListDeptAccess } from "@/lib/ops/cue-list-types";


const SM_GRANT_LEVELS = [
  { value: "view",  label: "查看" },
  { value: "mount", label: "挂载资产" },
  { value: "edit",  label: "编辑" },
  { value: "manage", label: "管理" },
] as const;
const SM_LEVEL_LABEL: Record<string, string> = Object.fromEntries(SM_GRANT_LEVELS.map(l => [l.value, l.label]));

export default function ShareModal({
  productionId, cueListId, cueListName, onClose,
}: {
  productionId: string;
  cueListId: string;
  cueListName: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [grants, setGrants] = useState<CueListGrant[]>([]);
  const [deptAccess, setDeptAccess] = useState<CueListDeptAccess[]>([]);
  const [productionDepts, setProductionDepts] = useState<{ id: string; name: string }[]>([]);
  const [members, setMembers] = useState<MemberWithRoles[]>([]);
  const [saving, setSaving] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  const [showAddDept, setShowAddDept] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [pendingUser, setPendingUser] = useState<{ userId: string; name: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const [d, membersRes] = await Promise.all([
        fetchCueListCollaborators(productionId, cueListId),
        fetch(`${BASE_PATH}/api/production/${productionId}/contacts`, { credentials: "include" }),
      ]);
      if (d) {
        setGrants(d.grants); setDeptAccess(d.deptAccess); setProductionDepts(d.productionDepts);
      }
      if (membersRes.ok) setMembers(await membersRes.json() as MemberWithRoles[]);
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const postCollaborator = async (body: object) => {
    setSaving(true);
    try {
      const d = await addCueListCollaborator(productionId, cueListId, body);
      if (d) { setGrants(d.grants); setDeptAccess(d.deptAccess); }
    } finally { setSaving(false); }
  };

  const deleteCollaborator = async (body: object) => {
    setSaving(true);
    try {
      const d = await removeCueListCollaborator(productionId, cueListId, body);
      if (d) { setGrants(d.grants); setDeptAccess(d.deptAccess); }
    } finally { setSaving(false); }
  };

  const grantedUserIds = new Set(grants.map(g => g.userId));
  const addedDeptIds = new Set(deptAccess.map(d => d.deptId));
  const availableDepts = productionDepts.filter(d => !addedDeptIds.has(d.id));
  const availableMembers = members.filter(m =>
    !grantedUserIds.has(m.userId) &&
    (userSearch === "" || m.name.includes(userSearch))
  );

  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--line)" };
  const removeBtnStyle: React.CSSProperties = { marginLeft: "auto", flexShrink: 0, border: 0, background: "transparent", fontSize: 11, color: "var(--muted)", cursor: saving ? "default" : "pointer", padding: "2px 6px", borderRadius: 5 };
  const addBtnStyle: React.CSSProperties = { border: "1px dashed var(--line)", background: "transparent", borderRadius: 7, padding: "5px 10px", fontSize: 11, color: "var(--muted)", cursor: "pointer", width: "100%", textAlign: "left" as const, marginTop: 4 };
  const labelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase" as const, color: "var(--muted)", marginBottom: 6 };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.25)", zIndex: 70 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: "min(480px, calc(100vw - 32px))", maxHeight: "calc(100vh - 80px)",
        background: "var(--surface)", borderRadius: 16, border: "1px solid var(--line)",
        boxShadow: "0 12px 40px rgba(24,42,42,.18)", zIndex: 71,
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
          <div>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 2 }}>分享协作</p>
            <h2 style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>{cueListName}</h2>
          </div>
          <button onClick={onClose} style={{ border: 0, background: "transparent", fontSize: 18, cursor: "pointer", color: "var(--muted)", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8 }}>×</button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>
          {loading ? (
            <p style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "24px 0" }}>加载中…</p>
          ) : (
            <>
              <div>
                <p style={labelStyle}>部门自助访问</p>
                {deptAccess.length === 0 && <p style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", marginBottom: 4 }}>暂无部门</p>}
                {deptAccess.map(d => (
                  <div key={d.deptId} style={rowStyle}>
                    <span style={{ fontSize: 12, color: "var(--ink)" }}>{d.deptName}</span>
                    <button style={removeBtnStyle} disabled={saving} onClick={() => deleteCollaborator({ type: "dept", deptId: d.deptId })}>移除</button>
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
                        onClick={async () => { await postCollaborator({ type: "dept", deptId: d.id }); setShowAddDept(false); }}>
                        {d.name}
                      </button>
                    ))}
                    <button style={{ ...addBtnStyle, marginTop: 2 }} onClick={() => setShowAddDept(false)}>取消</button>
                  </div>
                )}
                <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 }}>添加部门后，该部门符合条件的成员可自助确认访问</p>
              </div>

              <div>
                <p style={labelStyle}>个人直接授权</p>
                {grants.length === 0 && <p style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", marginBottom: 4 }}>暂无个人授权</p>}
                {grants.map(g => (
                  <div key={g.userId + g.level} style={rowStyle}>
                    <span style={{ fontSize: 12, color: "var(--ink)", flex: 1, minWidth: 0 }}>{g.userName}</span>
                    <OverflowSafeSelect
                      value={g.level}
                      disabled={saving}
                      onChange={async (e) => { await postCollaborator({ type: "user", userId: g.userId, level: e.target.value }); }}
                      style={{ fontSize: 11, border: "1px solid var(--line)", borderRadius: 5, padding: "2px 4px", background: "var(--surface)", color: "var(--ink)", cursor: saving ? "default" : "pointer" }}>
                      {SM_GRANT_LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </OverflowSafeSelect>
                    <button style={removeBtnStyle} disabled={saving}
                      onClick={() => deleteCollaborator({ type: "user", userId: g.userId })}>
                      移除
                    </button>
                  </div>
                ))}
                {!showAddUser && (
                  <button style={addBtnStyle} onClick={() => { setShowAddUser(true); setUserSearch(""); setPendingUser(null); }}>+ 添加成员</button>
                )}
                {showAddUser && (
                  <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                    {!pendingUser ? (
                      <>
                        <input
                          autoFocus placeholder="搜索姓名…" value={userSearch} onChange={e => setUserSearch(e.target.value)}
                          style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "6px 10px", fontSize: 12, outline: "none", background: "var(--surface)", color: "var(--ink)", marginBottom: 2 }}
                        />
                        {userSearch === ""
                          ? <p style={{ fontSize: 11, color: "var(--muted)", padding: "4px 2px" }}>输入姓名搜索成员…</p>
                          : availableMembers.length === 0
                          ? <p style={{ fontSize: 11, color: "var(--muted)", padding: "4px 2px" }}>无匹配成员</p>
                          : availableMembers.map(m => (
                            <button key={m.userId} disabled={saving}
                              style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "6px 10px", fontSize: 12, background: "var(--surface-2)", color: "var(--ink)", cursor: saving ? "default" : "pointer", textAlign: "left" }}
                              onClick={() => setPendingUser({ userId: m.userId, name: m.name })}>
                              <span>{m.name}</span>
                              {m.roles.length > 0 && <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{m.roles.slice(0, 2).join("、")}</span>}
                            </button>
                          ))
                        }
                      </>
                    ) : (
                      <>
                        <p style={{ fontSize: 12, color: "var(--ink)", padding: "4px 2px", fontWeight: 600 }}>
                          {pendingUser.name} — 选择权限
                        </p>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 2 }}>
                          {SM_GRANT_LEVELS.map(l => (
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
            </>
          )}
        </div>
      </div>
    </>
  );
}
