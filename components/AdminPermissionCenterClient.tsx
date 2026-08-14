"use client";

import { useMemo, useState } from "react";
import PageHeader from "@/components/PageHeader";
import Badge from "@/components/Badge";
import PermissionKeyPicker, { type Vocabulary } from "@/components/PermissionKeyPicker";
import styles from "@/components/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";

type Dept = { id: string; name: string; parentId: string | null; kind: "dept" | "group"; displayOrder: number };
type Role = { id: string; name: string; permissions: string[] };
type Member = { userId: string; name: string; roles: string[]; status: "active" | "suspended" };

type Caps = {
  deptView: boolean; deptEdit: boolean;
  roleView: boolean; roleEdit: boolean;
  overrideView: boolean; overrideEdit: boolean;
  rootOperation: boolean;
};

type Props = {
  productionId: string;
  productionName: string;
  depts: Dept[];
  initialDeptRows: Record<string, string[]>;
  initialRoles: Role[];
  members: Member[];
  initialOverrides: Record<string, Record<string, boolean>>;
  vocabulary: Vocabulary;
  caps: Caps;
};

const PRODUCER = "制作人";

const SECTION_LABEL: React.CSSProperties = {
  margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
  textTransform: "uppercase", color: "var(--stage)",
};

function KeyRow({ nodeKey, tone, onRemove, extra }: {
  nodeKey: string;
  tone?: "green" | "red";
  onRemove?: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
      <code style={{
        flex: 1, minWidth: 0, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        color: tone === "red" ? "var(--danger)" : tone === "green" ? "var(--success)" : "var(--ink)",
      }}>
        {nodeKey}
      </code>
      {extra}
      {onRemove && (
        <button
          onClick={onRemove}
          style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--muted)", fontSize: 13, lineHeight: 1, padding: "2px 6px" }}
          title="移除"
        >
          ×
        </button>
      )}
    </div>
  );
}

export default function AdminPermissionCenterClient({
  productionId, productionName, depts, initialDeptRows, initialRoles, members, initialOverrides, vocabulary, caps,
}: Props) {
  const tabs = [
    ...(caps.deptView ? [["dept", "部门权限"] as const] : []),
    ...(caps.roleView ? [["role", "角色权限"] as const] : []),
    ...(caps.overrideView ? [["override", "人事权限"] as const] : []),
  ];
  const [tab, setTab] = useState<"dept" | "role" | "override">(tabs[0]?.[0] ?? "dept");

  const [deptRows, setDeptRows] = useState(initialDeptRows);
  const [roles, setRoles] = useState(initialRoles);
  const [overrides, setOverrides] = useState(initialOverrides);

  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(depts[0]?.id ?? null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(initialRoles[0]?.id ?? null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── 部门树序 ──
  const deptTree = useMemo(() => {
    const byParent = new Map<string | null, Dept[]>();
    const ids = new Set(depts.map(d => d.id));
    for (const d of depts) {
      const key = d.parentId && ids.has(d.parentId) ? d.parentId : null;
      byParent.set(key, [...(byParent.get(key) ?? []), d]);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "zh"));
    const out: { dept: Dept; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const d of byParent.get(parent) ?? []) { out.push({ dept: d, depth }); walk(d.id, depth + 1); }
    };
    walk(null, 0);
    return out;
  }, [depts]);

  async function api(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}${path}`, {
        headers: { "Content-Type": "application/json" }, ...init,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "操作失败"); return null; }
      return data;
    } catch { setError("网络错误"); return null; }
    finally { setBusy(false); }
  }

  // ── 部门权限行 ──
  async function saveDeptKeys(deptId: string, keys: string[]) {
    const data = await api(`/departments/${deptId}/permissions`, { method: "PUT", body: JSON.stringify({ keys }) });
    if (data) setDeptRows(prev => ({ ...prev, [deptId]: (data.keys as string[]) ?? keys }));
  }

  // ── 角色权限键集 ──
  async function saveRoleKeys(role: Role, keys: string[]) {
    const data = await api(`/roles/${role.id}/permissions`, { method: "PUT", body: JSON.stringify({ permissions: keys }) });
    if (data) setRoles(prev => prev.map(r => (r.id === role.id ? { ...r, permissions: (data.permissions as string[]) ?? keys } : r)));
  }

  // ── override ──
  async function setOverride(userId: string, permission: string, granted: boolean | null) {
    if (await api(`/permissions`, { method: "PATCH", body: JSON.stringify({ userId, permission, granted }) })) {
      setOverrides(prev => {
        const mine = { ...(prev[userId] ?? {}) };
        if (granted === null) delete mine[permission];
        else mine[permission] = granted;
        return { ...prev, [userId]: mine };
      });
    }
  }

  const selectedDept = depts.find(d => d.id === selectedDeptId) ?? null;
  const selectedRole = roles.find(r => r.id === selectedRoleId) ?? null;
  const selectedMember = members.find(m => m.userId === selectedUserId) ?? null;

  const overrideCount = useMemo(
    () => Object.values(overrides).reduce((n, m) => n + Object.keys(m).length, 0),
    [overrides],
  );
  const deptKeyCount = useMemo(
    () => Object.values(deptRows).reduce((n, keys) => n + keys.length, 0),
    [deptRows],
  );

  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "7px 0", borderRadius: 8, border: "none", cursor: "pointer",
    fontSize: 12, fontWeight: 700,
    background: active ? "var(--ink)" : "transparent",
    color: active ? "#fff" : "var(--muted)",
  });

  const listBtn = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "8px 10px", borderRadius: 9, border: "none", cursor: "pointer", textAlign: "left",
    background: active ? "var(--ink)" : "transparent",
  });

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title="权限中心" side="stage" />

      {/* 摘要 */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(deptKeyCount), "部门权限行", "免审批区间"],
          [String(roles.reduce((n, r) => n + r.permissions.length, 0)), "角色权限键", `${roles.length} 个角色`],
          [String(overrideCount), "人事 override", "个人 allow / deny"],
        ].map(([num, label, hint]) => (
          <div key={label} style={{ minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13, background: "var(--surface)" }}>
            <span style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28, color: "var(--ink)" }}>{num}</span>
            <p style={{ margin: 0, display: "flex", flexDirection: "column" }}>
              <b style={{ fontSize: 11, color: "var(--ink)" }}>{label}</b>
              <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 9 }}>{hint}</small>
            </p>
          </div>
        ))}
      </div>

      {/* segmented */}
      <div style={{ display: "flex", gap: 4, padding: 4, background: "var(--surface-2)", borderRadius: 10, width: 360, marginBottom: 14 }}>
        {tabs.map(([key, label]) => (
          <button key={key} style={segBtn(tab === key)} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

      <section style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22,
        height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column",
      }}>
        <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
          <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
            {/* ── 左栏 ── */}
            <div className={`${styles.splitPane} ${styles.splitList}`}>
              <div style={{ paddingRight: 16 }}>
                {tab === "dept" && deptTree.map(({ dept, depth }) => (
                  <button key={dept.id} onClick={() => setSelectedDeptId(dept.id)} style={{ ...listBtn(selectedDeptId === dept.id), paddingLeft: 10 + depth * 16 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: selectedDeptId === dept.id ? "#fff" : "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {dept.name}
                    </span>
                    {dept.kind === "group" && <Badge tone="amber">组</Badge>}
                    <span style={{ fontSize: 10, color: selectedDeptId === dept.id ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
                      {(deptRows[dept.id] ?? []).length}
                    </span>
                  </button>
                ))}
                {tab === "role" && roles.map(r => (
                  <button key={r.id} onClick={() => setSelectedRoleId(r.id)} style={listBtn(selectedRoleId === r.id)}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: selectedRoleId === r.id ? "#fff" : "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name}
                    </span>
                    {r.name === PRODUCER && <Badge tone="amber">系统</Badge>}
                    <span style={{ fontSize: 10, color: selectedRoleId === r.id ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
                      {r.permissions.length}
                    </span>
                  </button>
                ))}
                {tab === "override" && members.map(m => {
                  const n = Object.keys(overrides[m.userId] ?? {}).length;
                  return (
                    <button key={m.userId} onClick={() => setSelectedUserId(m.userId)} style={listBtn(selectedUserId === m.userId)}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: selectedUserId === m.userId ? "#fff" : "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.name || "（未命名）"}
                      </span>
                      {n > 0 && <Badge tone={selectedUserId === m.userId ? "neutral" : "blue"}>{n}</Badge>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── 右栏 ── */}
            <div className={`${styles.splitPane} ${styles.splitDetail}`}>
              {tab === "dept" && (
                selectedDept ? (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>{selectedDept.name}</h2>
                      {selectedDept.kind === "group" ? <Badge tone="amber">用户组</Badge> : <Badge tone="blue">部门</Badge>}
                    </div>
                    <p style={{ margin: "0 0 14px", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
                      部门权限行是免审批区间：成员自确认进入部门即获得，伞语义沿子部门下传，退出部门自动撤销。
                    </p>
                    <p style={SECTION_LABEL}>权限行（{(deptRows[selectedDept.id] ?? []).length}）</p>
                    {(deptRows[selectedDept.id] ?? []).map(k => (
                      <KeyRow
                        key={k} nodeKey={k}
                        onRemove={caps.deptEdit ? () => saveDeptKeys(selectedDept.id, (deptRows[selectedDept.id] ?? []).filter(x => x !== k)) : undefined}
                      />
                    ))}
                    {(deptRows[selectedDept.id] ?? []).length === 0 && (
                      <p style={{ fontSize: 12, color: "var(--muted)" }}>无权限行</p>
                    )}
                    {caps.deptEdit && (
                      <div style={{ marginTop: 14 }}>
                        <PermissionKeyPicker
                          vocabulary={vocabulary} busy={busy}
                          onAdd={key => saveDeptKeys(selectedDept.id, [...(deptRows[selectedDept.id] ?? []), key])}
                        />
                      </div>
                    )}
                  </div>
                ) : <p style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧部门</p>
              )}

              {tab === "role" && (
                selectedRole ? (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>{selectedRole.name}</h2>
                      {selectedRole.name === PRODUCER && <Badge tone="amber">系统角色</Badge>}
                    </div>
                    {selectedRole.name === PRODUCER && !caps.rootOperation && (
                      <p style={{ margin: "0 0 14px", fontSize: 11, color: "var(--danger)", fontWeight: 700 }}>
                        制作人权限集合仅限所有者修改（ROOT OPERATION）。
                      </p>
                    )}
                    <p style={SECTION_LABEL}>权限键（{selectedRole.permissions.length}）</p>
                    {selectedRole.permissions.map(k => (
                      <KeyRow
                        key={k} nodeKey={k}
                        onRemove={caps.roleEdit && (selectedRole.name !== PRODUCER || caps.rootOperation)
                          ? () => saveRoleKeys(selectedRole, selectedRole.permissions.filter(x => x !== k))
                          : undefined}
                      />
                    ))}
                    {selectedRole.permissions.length === 0 && (
                      <p style={{ fontSize: 12, color: "var(--muted)" }}>零模板行（职能走部门声明）</p>
                    )}
                    {caps.roleEdit && (selectedRole.name !== PRODUCER || caps.rootOperation) && (
                      <div style={{ marginTop: 14 }}>
                        <PermissionKeyPicker
                          vocabulary={vocabulary} busy={busy}
                          onAdd={key => saveRoleKeys(selectedRole, [...selectedRole.permissions, key])}
                        />
                        <p style={{ margin: "8px 0 0", fontSize: 10, color: "var(--muted)" }}>
                          治理域键（node:production/ 与 node:producer/）不可经角色编辑写入，保存时将被服务端过滤。
                        </p>
                      </div>
                    )}
                  </div>
                ) : <p style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧角色</p>
              )}

              {tab === "override" && (
                selectedMember ? (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>
                        {selectedMember.name || "（未命名）"}
                      </h2>
                      {selectedMember.status === "suspended" && <Badge tone="red">已停用</Badge>}
                    </div>
                    <p style={{ margin: "0 0 14px", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
                      个人 override 覆盖角色/部门授权：<span style={{ color: "var(--success)", fontWeight: 700 }}>allow</span> 单独放行、
                      <span style={{ color: "var(--danger)", fontWeight: 700 }}> deny</span> 单独封禁。
                    </p>
                    <p style={SECTION_LABEL}>Override（{Object.keys(overrides[selectedMember.userId] ?? {}).length}）</p>
                    {Object.entries(overrides[selectedMember.userId] ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, granted]) => (
                      <KeyRow
                        key={k} nodeKey={k} tone={granted ? "green" : "red"}
                        extra={<Badge tone={granted ? "green" : "red"}>{granted ? "allow" : "deny"}</Badge>}
                        onRemove={caps.overrideEdit ? () => setOverride(selectedMember.userId, k, null) : undefined}
                      />
                    ))}
                    {Object.keys(overrides[selectedMember.userId] ?? {}).length === 0 && (
                      <p style={{ fontSize: 12, color: "var(--muted)" }}>无 override</p>
                    )}
                    {caps.overrideEdit && (
                      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                        <OverrideAdder
                          vocabulary={vocabulary} busy={busy}
                          onAdd={(key, granted) => setOverride(selectedMember.userId, key, granted)}
                        />
                      </div>
                    )}
                  </div>
                ) : <p style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧成员</p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function OverrideAdder({ vocabulary, busy, onAdd }: {
  vocabulary: Vocabulary;
  busy: boolean;
  onAdd: (key: string, granted: boolean) => void;
}) {
  const [granted, setGranted] = useState(true);
  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button
          onClick={() => setGranted(true)}
          style={{
            padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer",
            border: "1px solid " + (granted ? "var(--success)" : "var(--line)"),
            background: granted ? "var(--success-soft)" : "var(--paper)",
            color: granted ? "var(--success)" : "var(--muted)",
          }}
        >
          allow
        </button>
        <button
          onClick={() => setGranted(false)}
          style={{
            padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer",
            border: "1px solid " + (!granted ? "var(--danger)" : "var(--line)"),
            background: !granted ? "var(--danger-soft)" : "var(--paper)",
            color: !granted ? "var(--danger)" : "var(--muted)",
          }}
        >
          deny
        </button>
      </div>
      <PermissionKeyPicker vocabulary={vocabulary} busy={busy} onAdd={key => onAdd(key, granted)} />
    </div>
  );
}
