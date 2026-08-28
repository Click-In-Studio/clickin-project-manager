"use client";

import OverflowSafeSelect from "@/components/OverflowSafeSelect";

import { useMemo, useState } from "react";
import PageHeader, { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import Badge from "@/components/Badge";
import AdminModal from "@/components/AdminModal";
import MemberPickerModal from "@/components/MemberPickerModal";
import InviteModal from "@/components/InviteModal";
import TreePickerModal from "@/components/TreePickerModal";
import styles from "@/components/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberTag } from "@/lib/db";
import type { MemberStatus, MemberStatusSource } from "@/lib/member-status-shared";
import { memberStatusLabel } from "@/lib/member-status-shared";
import { isInactiveMember } from "@/lib/member-status-shared";

type Member = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  email: string | null;
  phone: string | null;
  roles: string[];
  tags: string[];
  photoUrl: string | null;
  supervisorId: string | null;
  supervisorName: string | null;
  status: MemberStatus;
  statusSource: MemberStatusSource | null;
};

type Dept = {
  id: string;
  name: string;
  parentId: string | null;
  kind: "dept" | "group";
  displayOrder: number;
  memberUserIds: string[];
  pocUserIds: string[];
};

type Caps = {
  viewContact: boolean;
  editMember: boolean;
  invite: boolean;
  remove: boolean;
  deptStructure: boolean;
  deptMembers: boolean;
  deptPoc: boolean;
};

type Props = {
  productionId: string;
  productionName: string;
  initialMembers: Member[];
  initialDepts: Dept[];
  tags: MemberTag[];
  roleNames: string[];
  caps: Caps;
  currentUserId: string;
};

const SECTION_LABEL: React.CSSProperties = {
  margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
  textTransform: "uppercase", color: "var(--stage)",
};

function Avatar({ m, size }: { m: Member; size: number }) {
  const url = m.photoUrl || m.avatarUrl;
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
  ) : (
    <span style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: "var(--script-soft)", color: "var(--script)",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.42, fontWeight: 700,
    }}>
      {m.name.slice(0, 1) || "?"}
    </span>
  );
}

export default function AdminOrganizationClient({
  productionId, productionName, initialMembers, initialDepts, tags, roleNames, caps, currentUserId,
}: Props) {
  const [tab, setTab] = useState<"members" | "depts">("members");
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [depts, setDepts] = useState<Dept[]>(initialDepts);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(initialDepts[0]?.id ?? null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const memberMap = useMemo(() => new Map(members.map(m => [m.userId, m])), [members]);
  const selected = selectedUserId ? memberMap.get(selectedUserId) ?? null : null;
  const selectedDept = selectedDeptId ? depts.find(d => d.id === selectedDeptId) ?? null : null;

  const pocCount = useMemo(() => depts.reduce((n, d) => n + d.pocUserIds.length, 0), [depts]);

  async function api(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}${path}`, {
        headers: { "Content-Type": "application/json" }, ...init,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "操作失败"); return false; }
      return true;
    } catch { setError("网络错误"); return false; }
    finally { setBusy(false); }
  }

  // ── 成员操作 ──
  async function patchMember(userId: string, body: Record<string, unknown>, apply: (m: Member) => Member) {
    if (await api(`/members`, { method: "PATCH", body: JSON.stringify({ userId, ...body }) })) {
      setMembers(prev => prev.map(m => (m.userId === userId ? apply(m) : m)));
    }
  }

  /**
   * 成员状态处置（#141）。走动词形端点而不是 PATCH { status }：
   * active → suspended 既可能是自助退出也可能是人事停用，赋值形反推不出来。
   */
  async function memberAction(
    userId: string,
    action: "suspend" | "restore" | "confirm_exit",
    apply: (m: Member) => Member,
  ) {
    if (await api(`/members/${userId}/status`, {
      method: "POST",
      body: JSON.stringify({ action }),
    })) {
      setMembers(prev => prev.map(m => (m.userId === userId ? apply(m) : m)));
    }
  }

  // ── 部门操作 ──
  async function saveDeptMembers(dept: Dept, memberUserIds: string[], pocUserIds: string[]) {
    const body = {
      members: memberUserIds.map(uid => ({ userId: uid, isPoc: pocUserIds.includes(uid) })),
    };
    if (await api(`/departments/${dept.id}/members`, { method: "PUT", body: JSON.stringify(body) })) {
      setDepts(prev => prev.map(d => (d.id === dept.id ? { ...d, memberUserIds, pocUserIds } : d)));
    }
  }

  async function patchDept(deptId: string, body: Record<string, unknown>, apply: (d: Dept) => Dept) {
    if (await api(`/departments/${deptId}`, { method: "PATCH", body: JSON.stringify(body) })) {
      setDepts(prev => prev.map(d => (d.id === deptId ? apply(d) : d)));
    }
  }

  async function createDept(name: string, parentId: string | null, kind: "dept" | "group") {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/departments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId, kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "创建失败"); return; }
      const d = data.department;
      setDepts(prev => [...prev, {
        id: d.id, name: d.name, parentId: d.parentId ?? null, kind: d.kind,
        displayOrder: d.displayOrder ?? 0, memberUserIds: [], pocUserIds: [],
      }]);
      setSelectedDeptId(d.id);
    } catch { setError("网络错误"); }
    finally { setBusy(false); }
  }

  async function deleteDept(dept: Dept) {
    if (!confirm(`确认删除「${dept.name}」？`)) return;
    if (await api(`/departments/${dept.id}`, { method: "DELETE" })) {
      setDepts(prev => prev.filter(d => d.id !== dept.id).map(d => (d.parentId === dept.id ? { ...d, parentId: null } : d)));
      setSelectedDeptId(prev => (prev === dept.id ? null : prev));
    }
  }

  // ── 成员分组（按部门） ──
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (m: Member) =>
      !q || m.name.toLowerCase().includes(q) || m.roles.some(r => r.toLowerCase().includes(q));
    const assigned = new Set<string>();
    const groups: { dept: Dept | null; members: Member[] }[] = [];
    for (const d of depts.filter(d => d.kind === "dept")) {
      const ms = d.memberUserIds.map(id => memberMap.get(id)).filter((m): m is Member => !!m && match(m));
      d.memberUserIds.forEach(id => assigned.add(id));
      if (ms.length) groups.push({ dept: d, members: ms });
    }
    const rest = members.filter(m => !assigned.has(m.userId) && match(m));
    if (rest.length) groups.push({ dept: null, members: rest });
    return groups;
  }, [depts, members, memberMap, query]);

  // ── 部门树 ──
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
      for (const d of byParent.get(parent) ?? []) {
        out.push({ dept: d, depth });
        walk(d.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [depts]);

  function descendants(deptId: string): Set<string> {
    const out = new Set<string>([deptId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of depts) {
        if (d.parentId && out.has(d.parentId) && !out.has(d.id)) { out.add(d.id); grew = true; }
      }
    }
    return out;
  }

  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "7px 0", borderRadius: 8, border: "none", cursor: "pointer",
    fontSize: 12, fontWeight: 700,
    background: active ? "var(--ink)" : "transparent",
    color: active ? "#fff" : "var(--muted)",
  });

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader
        eyebrow={productionName}
        title="成员与部门"
        side="stage"
        actions={caps.invite ? (
          <button style={PRIMARY_BTN} onClick={() => setInviteOpen(true)}>＋ 邀请成员</button>
        ) : undefined}
      />

      {/* 摘要 */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [
            String(members.length),
            "项目成员",
            members.some(m => m.status !== "active")
              ? `含 ${members.filter(m => m.status !== "active").length} 名不在职`
              : "全部在职",
          ],
          [String(depts.filter(d => d.kind === "dept").length), "部门", "组织架构"],
          [String(depts.filter(d => d.kind === "group").length), "用户组", "仅供选人"],
          [String(pocCount), "POC", "部门联络人次"],
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
      <div style={{ display: "flex", gap: 4, padding: 4, background: "var(--surface-2)", borderRadius: 10, width: 280, marginBottom: 14 }}>
        <button style={segBtn(tab === "members")} onClick={() => setTab("members")}>成员</button>
        <button style={segBtn(tab === "depts")} onClick={() => setTab("depts")}>部门</button>
      </div>

      {error && (
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>
      )}

      {/* Panel */}
      <section style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22,
        height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column",
      }}>
        <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
          <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
            {/* ── 左栏 ── */}
            <div className={`${styles.splitPane} ${styles.splitList}`}>
              {tab === "members" ? (
                <div style={{ paddingRight: 16 }}>
                  <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="搜索姓名 / 角色"
                    style={{
                      width: "100%", padding: "8px 10px", marginBottom: 10, fontSize: 12,
                      border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)",
                    }}
                  />
                  {grouped.map(({ dept, members: ms }) => (
                    <div key={dept?.id ?? "__none"} style={{ marginBottom: 10 }}>
                      <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: "var(--muted)", textTransform: "uppercase" }}>
                        {dept?.name ?? "未分配部门"}
                      </p>
                      {ms.map(m => {
                        const active = selectedUserId === m.userId;
                        return (
                          <button
                            key={m.userId}
                            onClick={() => setSelectedUserId(m.userId)}
                            style={{
                              display: "flex", alignItems: "center", gap: 9, width: "100%",
                              padding: "7px 9px", borderRadius: 9, border: "none", cursor: "pointer",
                              background: active ? "var(--ink)" : "transparent", textAlign: "left",
                            }}
                          >
                            <Avatar m={m} size={26} />
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <span style={{
                                display: "block", fontSize: 13, fontWeight: 600,
                                color: active ? "#fff" : isInactiveMember(m.status) ? "var(--muted)" : "var(--ink)",
                                textDecoration: isInactiveMember(m.status) ? "line-through" : undefined,
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              }}>
                                {m.name || "（未命名）"}
                              </span>
                              <span style={{ display: "block", fontSize: 10, color: active ? "rgba(255,255,255,.6)" : "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {m.roles.join(" · ") || "无角色"}
                              </span>
                            </span>
                            {dept && dept.pocUserIds.includes(m.userId) && (
                              <span style={{ fontSize: 10, color: active ? "#fff" : "var(--stage)" }}>★</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  {grouped.length === 0 && (
                    <p style={{ fontSize: 12, color: "var(--muted)", paddingTop: 20, textAlign: "center" }}>无匹配成员</p>
                  )}
                </div>
              ) : (
                <div style={{ paddingRight: 16 }}>
                  {deptTree.map(({ dept, depth }) => {
                    const active = selectedDeptId === dept.id;
                    return (
                      <button
                        key={dept.id}
                        onClick={() => setSelectedDeptId(dept.id)}
                        style={{
                          display: "flex", alignItems: "center", gap: 7, width: "100%",
                          padding: "7px 9px", paddingLeft: 9 + depth * 16, borderRadius: 9,
                          border: "none", cursor: "pointer", textAlign: "left",
                          background: active ? "var(--ink)" : "transparent",
                        }}
                      >
                        <span style={{ fontSize: 10, color: active ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
                          {depth > 0 ? "└" : "▪"}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: active ? "#fff" : "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {dept.name}
                        </span>
                        {dept.kind === "group" && <Badge tone="amber">组</Badge>}
                        <span style={{ fontSize: 10, color: active ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
                          {dept.memberUserIds.length}
                        </span>
                      </button>
                    );
                  })}
                  {caps.deptStructure && (
                    <NewDeptForm depts={depts} busy={busy} onCreate={createDept} />
                  )}
                </div>
              )}
            </div>

            {/* ── 右栏 ── */}
            <div className={`${styles.splitPane} ${styles.splitDetail}`}>
              {tab === "members" ? (
                selected ? (
                  <MemberDetail
                    key={selected.userId}
                    member={selected}
                    depts={depts}
                    allMembers={members}
                    tags={tags}
                    roleNames={roleNames}
                    caps={caps}
                    busy={busy}
                    isSelf={selected.userId === currentUserId}
                    onPatch={patchMember}
                    onAction={memberAction}
                    onSaveDeptMembers={saveDeptMembers}
                  />
                ) : (
                  <p style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧成员查看详情</p>
                )
              ) : selectedDept ? (
                <DeptDetail
                  key={selectedDept.id}
                  dept={selectedDept}
                  depts={depts}
                  members={members}
                  caps={caps}
                  busy={busy}
                  descendants={descendants}
                  onPatch={patchDept}
                  onSaveMembers={saveDeptMembers}
                  onDelete={deleteDept}
                  onCreateChild={createDept}
                />
              ) : (
                <p style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧部门查看详情</p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 邀请（#156：邮件邀请 + 邀请链接；批量在数据迁移页） */}
      {inviteOpen && (
        <InviteModal
          productionId={productionId}
          roleNames={roleNames}
          depts={depts.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, kind: d.kind }))}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </div>
  );
}

// ─── 成员详情 ─────────────────────────────────────────────────────────────────

function MemberDetail({
  member: m, depts, allMembers, tags, roleNames, caps, busy, isSelf, onPatch, onAction, onSaveDeptMembers,
}: {
  member: Member;
  depts: Dept[];
  allMembers: Member[];
  tags: MemberTag[];
  roleNames: string[];
  caps: Caps;
  busy: boolean;
  isSelf: boolean;
  onPatch: (userId: string, body: Record<string, unknown>, apply: (m: Member) => Member) => Promise<void>;
  onAction: (
    userId: string,
    action: "suspend" | "restore" | "confirm_exit",
    apply: (m: Member) => Member,
  ) => Promise<void>;
  onSaveDeptMembers: (dept: Dept, memberUserIds: string[], pocUserIds: string[]) => Promise<void>;
}) {
  const myDepts = depts.filter(d => d.memberUserIds.includes(m.userId));
  const [supPickerOpen, setSupPickerOpen] = useState(false);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [deptPickerOpen, setDeptPickerOpen] = useState(false);

  async function saveDeptMembership(selectedIds: string[]) {
    const cur = new Set(myDepts.map(d => d.id));
    const next = new Set(selectedIds);
    for (const d of depts) {
      if (next.has(d.id) && !cur.has(d.id)) {
        await onSaveDeptMembers(d, [...d.memberUserIds, m.userId], d.pocUserIds);
      } else if (!next.has(d.id) && cur.has(d.id)) {
        await onSaveDeptMembers(d, d.memberUserIds.filter(id => id !== m.userId), d.pocUserIds.filter(id => id !== m.userId));
      }
    }
  }

  function toggleTag(tag: MemberTag) {
    const has = m.tags.includes(tag.name);
    const nextNames = has ? m.tags.filter(t => t !== tag.name) : [...m.tags, tag.name];
    const nextIds = tags.filter(t => nextNames.includes(t.name)).map(t => t.id);
    onPatch(m.userId, { tagIds: nextIds }, mm => ({ ...mm, tags: nextNames }));
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
        <Avatar m={m} size={52} />
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)", display: "flex", alignItems: "center", gap: 10 }}>
            {m.name || "（未命名）"}
            {m.status === "active"
              ? <Badge tone="green">在职</Badge>
              : <Badge tone="red">{memberStatusLabel(m.status, m.statusSource)}</Badge>}
          </h2>
          <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--muted)" }}>
            {m.roles.join(" · ") || "无角色"}
          </p>
        </div>
      </div>

      {/* 角色 */}
      <div style={{ marginBottom: 16 }}>
        <p style={SECTION_LABEL}>角色</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {m.roles.length ? m.roles.map(r => <Badge key={r} tone="blue">{r}</Badge>) : <span style={{ fontSize: 12, color: "var(--muted)" }}>未指派</span>}
          {caps.editMember && (
            <button style={{ ...SECONDARY_BTN, padding: "3px 10px", fontSize: 10 }} disabled={busy} onClick={() => setRolePickerOpen(true)}>
              编辑
            </button>
          )}
        </div>
        {rolePickerOpen && (
          <TreePickerModal
            kicker="组织架构"
            title={`编辑「${m.name}」的角色`}
            items={roleNames.map(r => ({
              id: r, label: r,
              disabled: r === "制作人",
              badge: r === "制作人" ? "系统" : undefined,
            }))}
            preselected={m.roles}
            busy={busy}
            onClose={() => setRolePickerOpen(false)}
            onConfirm={async (selected) => {
              await onPatch(m.userId, { roles: selected }, mm => ({ ...mm, roles: selected }));
              setRolePickerOpen(false);
            }}
          />
        )}
      </div>

      {/* 标签 */}
      <div style={{ marginBottom: 16 }}>
        <p style={SECTION_LABEL}>标签</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {tags.map(t => {
            const on = m.tags.includes(t.name);
            if (!caps.editMember) {
              return on ? <Badge key={t.id} tone="neutral">{t.name}</Badge> : null;
            }
            return (
              <button
                key={t.id}
                disabled={busy}
                onClick={() => toggleTag(t)}
                style={{
                  padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer",
                  border: "1px solid " + (on ? "var(--ink)" : "var(--line)"),
                  background: on ? "var(--ink)" : "var(--paper)",
                  color: on ? "#fff" : "var(--muted)",
                }}
              >
                {t.name}
              </button>
            );
          })}
          {!caps.editMember && m.tags.length === 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>无标签</span>}
        </div>
      </div>

      {/* 上级 */}
      <div style={{ marginBottom: 16 }}>
        <p style={SECTION_LABEL}>汇报上级</p>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, color: "var(--ink)" }}>{m.supervisorName ?? "（无）"}</span>
          {caps.editMember && (
            <>
              <button
                style={{ ...SECONDARY_BTN, padding: "3px 10px", fontSize: 10 }}
                disabled={busy}
                onClick={() => setSupPickerOpen(true)}
              >
                {m.supervisorId ? "更换" : "设置"}
              </button>
              {m.supervisorId && (
                <button
                  style={{ ...SECONDARY_BTN, padding: "3px 10px", fontSize: 10, borderColor: "var(--danger)", color: "var(--danger)" }}
                  disabled={busy}
                  onClick={() => onPatch(m.userId, { supervisorId: null }, mm => ({ ...mm, supervisorId: null, supervisorName: null }))}
                >
                  清除
                </button>
              )}
            </>
          )}
        </div>
        {supPickerOpen && (
          <MemberPickerModal
            kicker="组织架构"
            title={`设置「${m.name}」的汇报上级`}
            single
            members={allMembers}
            depts={depts}
            excludeUserIds={[m.userId]}
            busy={busy}
            onClose={() => setSupPickerOpen(false)}
            onConfirm={async ([supId]) => {
              const sup = allMembers.find(x => x.userId === supId) ?? null;
              await onPatch(m.userId, { supervisorId: supId }, mm => ({ ...mm, supervisorId: supId, supervisorName: sup?.name ?? null }));
              setSupPickerOpen(false);
            }}
          />
        )}
      </div>

      {/* 部门归属 */}
      <div style={{ marginBottom: 16 }}>
        <p style={SECTION_LABEL}>部门归属</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {myDepts.length ? myDepts.map(d => (
            <Badge key={d.id} tone={d.kind === "group" ? "amber" : "neutral"}>
              {d.name}{d.pocUserIds.includes(m.userId) ? " ★POC" : ""}
            </Badge>
          )) : <span style={{ fontSize: 12, color: "var(--muted)" }}>未分配</span>}
          {caps.deptMembers && (
            <button style={{ ...SECONDARY_BTN, padding: "3px 10px", fontSize: 10 }} disabled={busy} onClick={() => setDeptPickerOpen(true)}>
              编辑
            </button>
          )}
        </div>
        {deptPickerOpen && (
          <TreePickerModal
            kicker="组织架构"
            title={`编辑「${m.name}」的部门归属`}
            items={depts.map(d => ({
              id: d.id, label: d.name, parentId: d.parentId,
              badge: d.kind === "group" ? "组" : undefined,
            }))}
            preselected={myDepts.map(d => d.id)}
            busy={busy}
            onClose={() => setDeptPickerOpen(false)}
            onConfirm={async (selected) => {
              await saveDeptMembership(selected);
              setDeptPickerOpen(false);
            }}
          />
        )}
      </div>

      {/* 联系方式（可见门裁剪：无权时 SSR 已置 null，此处整段隐藏） */}
      {caps.viewContact && (
        <div style={{ marginBottom: 16 }}>
          <p style={SECTION_LABEL}>联系方式</p>
          <p style={{ margin: "0 0 3px", fontSize: 13, color: "var(--ink)" }}>邮箱：{m.email ?? "（未登记）"}</p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink)" }}>电话：{m.phone ?? "（未登记）"}</p>
        </div>
      )}

      {/* 成员处置（#141）*/}
      {caps.remove && !isSelf && m.status !== "exited" && (
        <div style={{ marginTop: 24, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <p style={{ ...SECTION_LABEL, color: "var(--danger)" }}>成员处置</p>

          {isInactiveMember(m.status) && (
            <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
              {m.statusSource === "self"
                ? "该成员已自行退出，访问权已冻结。"
                : "该成员已被停用，访问权已冻结。"}
              授权原样保留——复职无需重新配置；确认离组才会撤销授权，届时其署名与操作记录仍保留。
            </p>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {m.status === "active" ? (
              <button
                disabled={busy}
                onClick={() => onAction(m.userId, "suspend", mm => ({
                  ...mm, status: "suspended", statusSource: "admin",
                }))}
                style={{ ...SECONDARY_BTN, borderColor: "var(--danger)", color: "var(--danger)" }}
              >
                停用
              </button>
            ) : (
              <>
                <button
                  disabled={busy}
                  onClick={() => onAction(m.userId, "restore", mm => ({
                    ...mm, status: "active", statusSource: null,
                  }))}
                  style={SECONDARY_BTN}
                >
                  复职
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (!confirm("确认该成员已离组？其全部授权将被撤销；成员记录与署名保留。")) return;
                    onAction(m.userId, "confirm_exit", mm => ({ ...mm, status: "exited" }));
                  }}
                  style={{ ...PRIMARY_BTN, background: "var(--danger)", borderColor: "var(--danger)" }}
                >
                  确认离组
                </button>
              </>
            )}
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--muted)" }}>
            成员记录不可删除。加错人也走「停用 → 确认离组」——名册留一条离组记录，
            换的是任何人都无法抹掉痕迹。
          </p>
        </div>
      )}
    </div>
  );
}

// ─── 部门详情 ─────────────────────────────────────────────────────────────────

function DeptDetail({
  dept, depts, members, caps, busy, descendants, onPatch, onSaveMembers, onDelete, onCreateChild,
}: {
  dept: Dept;
  depts: Dept[];
  members: Member[];
  caps: Caps;
  busy: boolean;
  descendants: (id: string) => Set<string>;
  onPatch: (deptId: string, body: Record<string, unknown>, apply: (d: Dept) => Dept) => Promise<void>;
  onSaveMembers: (dept: Dept, memberUserIds: string[], pocUserIds: string[]) => Promise<void>;
  onDelete: (dept: Dept) => Promise<void>;
  onCreateChild: (name: string, parentId: string | null, kind: "dept" | "group") => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(dept.name);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  const [childName, setChildName] = useState("");
  const [childKind, setChildKind] = useState<"dept" | "group">("dept");

  const memberMap = new Map(members.map(m => [m.userId, m]));
  const blocked = descendants(dept.id);
  const parentDept = dept.parentId ? depts.find(d => d.id === dept.parentId) ?? null : null;

  return (
    <div>
      {/* 标题/改名 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        {renaming ? (
          <>
            <input
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              style={{ fontSize: 17, fontFamily: 'Georgia, "Noto Serif SC", serif', padding: "5px 9px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}
            />
            <button
              style={PRIMARY_BTN} disabled={busy || !nameDraft.trim()}
              onClick={async () => { await onPatch(dept.id, { name: nameDraft.trim() }, d => ({ ...d, name: nameDraft.trim() })); setRenaming(false); }}
            >
              保存
            </button>
            <button style={SECONDARY_BTN} onClick={() => { setNameDraft(dept.name); setRenaming(false); }}>取消</button>
          </>
        ) : (
          <>
            <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>{dept.name}</h2>
            {dept.kind === "group" ? <Badge tone="amber">用户组</Badge> : <Badge tone="blue">部门</Badge>}
            {caps.deptStructure && (
              <button style={{ ...SECONDARY_BTN, padding: "4px 10px", fontSize: 11 }} onClick={() => setRenaming(true)}>改名</button>
            )}
          </>
        )}
      </div>

      {/* 结构设置 */}
      {caps.deptStructure && (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 18 }}>
          <div>
            <p style={SECTION_LABEL}>上级部门</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: "var(--ink)" }}>{parentDept?.name ?? "（顶级）"}</span>
              <button
                style={{ ...SECONDARY_BTN, padding: "3px 10px", fontSize: 10 }}
                disabled={busy}
                onClick={() => setParentPickerOpen(true)}
              >
                更换
              </button>
              {dept.parentId && (
                <button
                  style={{ ...SECONDARY_BTN, padding: "3px 10px", fontSize: 10 }}
                  disabled={busy}
                  onClick={() => onPatch(dept.id, { parentId: null }, d => ({ ...d, parentId: null }))}
                >
                  设为顶级
                </button>
              )}
            </div>
          </div>
          <div>
            <p style={SECTION_LABEL}>类型</p>
            <OverflowSafeSelect
              value={dept.kind}
              disabled={busy}
              onChange={e => {
                const v = e.target.value === "group" ? "group" : "dept";
                onPatch(dept.id, { kind: v }, d => ({ ...d, kind: v }));
              }}
              style={{ padding: "7px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", minWidth: 120 }}
            >
              <option value="dept">部门</option>
              <option value="group">用户组</option>
            </OverflowSafeSelect>
          </div>
          <div>
            <p style={SECTION_LABEL}>子部门</p>
            <button
              style={{ ...SECONDARY_BTN, padding: "5px 12px", fontSize: 11 }}
              disabled={busy}
              onClick={() => setChildOpen(true)}
            >
              ＋ 添加子部门
            </button>
          </div>
        </div>
      )}
      {parentPickerOpen && (
        <TreePickerModal
          kicker="组织架构"
          title={`选择「${dept.name}」的上级部门`}
          single
          items={depts.filter(d => !blocked.has(d.id)).map(d => ({
            id: d.id, label: d.name, parentId: d.parentId,
            badge: d.kind === "group" ? "组" : undefined,
          }))}
          preselected={dept.parentId ? [dept.parentId] : []}
          busy={busy}
          onClose={() => setParentPickerOpen(false)}
          onConfirm={async ([pid]) => {
            await onPatch(dept.id, { parentId: pid }, d => ({ ...d, parentId: pid }));
            setParentPickerOpen(false);
          }}
        />
      )}
      {childOpen && (
        <AdminModal kicker="组织架构" title={`在「${dept.name}」下新建子部门`} onClose={() => setChildOpen(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              value={childName} onChange={e => setChildName(e.target.value)} placeholder="名称" autoFocus
              style={{ padding: "9px 11px", fontSize: 13, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}
            />
            <OverflowSafeSelect
              value={childKind} onChange={e => setChildKind(e.target.value === "group" ? "group" : "dept")}
              style={{ padding: "9px 11px", fontSize: 13, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}
            >
              <option value="dept">部门</option>
              <option value="group">用户组</option>
            </OverflowSafeSelect>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={SECONDARY_BTN} onClick={() => setChildOpen(false)}>取消</button>
              <button
                style={PRIMARY_BTN} disabled={busy || !childName.trim()}
                onClick={async () => {
                  await onCreateChild(childName.trim(), dept.id, childKind);
                  setChildName(""); setChildOpen(false);
                }}
              >
                创建
              </button>
            </div>
          </div>
        </AdminModal>
      )}

      {/* 成员与 POC */}
      <div style={{ marginBottom: 18 }}>
        <p style={SECTION_LABEL}>成员（{dept.memberUserIds.length}）</p>
        {dept.memberUserIds.map(uid => {
          const m = memberMap.get(uid);
          if (!m) return null;
          const isPoc = dept.pocUserIds.includes(uid);
          return (
            <div key={uid} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
              <Avatar m={m} size={26} />
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{m.name || "（未命名）"}</span>
              {isPoc && <Badge tone="amber">POC</Badge>}
              {caps.deptPoc && (
                <button
                  disabled={busy}
                  onClick={() => onSaveMembers(
                    dept,
                    dept.memberUserIds,
                    isPoc ? dept.pocUserIds.filter(id => id !== uid) : [...dept.pocUserIds, uid],
                  )}
                  style={{ ...SECONDARY_BTN, padding: "3px 9px", fontSize: 10 }}
                >
                  {isPoc ? "取消 POC" : "设为 POC"}
                </button>
              )}
              {caps.deptMembers && (
                <button
                  disabled={busy}
                  onClick={() => onSaveMembers(
                    dept,
                    dept.memberUserIds.filter(id => id !== uid),
                    dept.pocUserIds.filter(id => id !== uid),
                  )}
                  style={{ ...SECONDARY_BTN, padding: "3px 9px", fontSize: 10, borderColor: "var(--danger)", color: "var(--danger)" }}
                >
                  移除
                </button>
              )}
            </div>
          );
        })}
        {caps.deptMembers && (
          <button style={{ ...SECONDARY_BTN, marginTop: 10 }} onClick={() => setPickerOpen(true)}>
            ＋ 添加成员
          </button>
        )}
        {pickerOpen && (
          <MemberPickerModal
            kicker="组织架构"
            title={`添加成员到「${dept.name}」`}
            members={members}
            depts={depts}
            excludeUserIds={dept.memberUserIds}
            busy={busy}
            onClose={() => setPickerOpen(false)}
            onConfirm={async (userIds) => {
              await onSaveMembers(dept, [...dept.memberUserIds, ...userIds], dept.pocUserIds);
              setPickerOpen(false);
            }}
          />
        )}
      </div>

      {/* 危险区 */}
      {caps.deptStructure && (
        <div style={{ marginTop: 24, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <p style={{ ...SECTION_LABEL, color: "var(--danger)" }}>危险区</p>
          <button
            disabled={busy}
            onClick={() => onDelete(dept)}
            style={{ ...SECONDARY_BTN, borderColor: "var(--danger)", color: "var(--danger)" }}
          >
            删除{dept.kind === "group" ? "用户组" : "部门"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── 新建部门 ─────────────────────────────────────────────────────────────────

function NewDeptForm({ depts, busy, onCreate }: {
  depts: Dept[];
  busy: boolean;
  onCreate: (name: string, parentId: string | null, kind: "dept" | "group") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [kind, setKind] = useState<"dept" | "group">("dept");

  const FIELD: React.CSSProperties = {
    padding: "9px 11px", fontSize: 13, border: "1px solid var(--line)", borderRadius: 8,
    background: "var(--paper)", color: "var(--ink)",
  };
  return (
    <>
      <button style={{ ...SECONDARY_BTN, width: "100%", marginTop: 10 }} onClick={() => setOpen(true)}>
        ＋ 新建部门 / 用户组
      </button>
      {open && (
        <AdminModal kicker="组织架构" title="新建部门 / 用户组" onClose={() => setOpen(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="名称" autoFocus style={FIELD} />
            <OverflowSafeSelect value={parentId} onChange={e => setParentId(e.target.value)} style={FIELD}>
              <option value="">（顶级）</option>
              {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </OverflowSafeSelect>
            <OverflowSafeSelect value={kind} onChange={e => setKind(e.target.value === "group" ? "group" : "dept")} style={FIELD}>
              <option value="dept">部门</option>
              <option value="group">用户组</option>
            </OverflowSafeSelect>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={SECONDARY_BTN} onClick={() => setOpen(false)}>取消</button>
              <button style={PRIMARY_BTN} disabled={busy || !name.trim()}
                onClick={async () => { await onCreate(name.trim(), parentId || null, kind); setName(""); setOpen(false); }}>
                创建
              </button>
            </div>
          </div>
        </AdminModal>
      )}
    </>
  );
}
