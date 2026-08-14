"use client";

import { useMemo, useState } from "react";
import PageHeader, { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import Badge from "@/components/Badge";
import AdminModal from "@/components/AdminModal";
import MemberPickerModal from "@/components/MemberPickerModal";
import styles from "@/components/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberTag } from "@/lib/db";

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
  status: "active" | "suspended";
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
  productionId, productionName, initialMembers, initialDepts, tags, caps, currentUserId,
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

  async function removeMember(userId: string) {
    if (!confirm("确认将该成员从项目中清退？其全部授权将被级联撤销。")) return;
    if (await api(`/members`, { method: "DELETE", body: JSON.stringify({ userId }) })) {
      setMembers(prev => prev.filter(m => m.userId !== userId));
      setDepts(prev => prev.map(d => ({
        ...d,
        memberUserIds: d.memberUserIds.filter(id => id !== userId),
        pocUserIds: d.pocUserIds.filter(id => id !== userId),
      })));
      setSelectedUserId(null);
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
          <div style={{ display: "flex", gap: 8 }}>
            <button style={SECONDARY_BTN} onClick={() => setInviteOpen(true)}>批量邀请</button>
            <button style={PRIMARY_BTN} onClick={() => setInviteOpen(true)}>＋ 邀请成员</button>
          </div>
        ) : undefined}
      />

      {/* 摘要 */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(members.length), "项目成员", members.some(m => m.status === "suspended") ? `含 ${members.filter(m => m.status === "suspended").length} 名停用` : "全部在职"],
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
                                color: active ? "#fff" : m.status === "suspended" ? "var(--muted)" : "var(--ink)",
                                textDecoration: m.status === "suspended" ? "line-through" : undefined,
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
                    caps={caps}
                    busy={busy}
                    isSelf={selected.userId === currentUserId}
                    onPatch={patchMember}
                    onRemove={removeMember}
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
                />
              ) : (
                <p style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧部门查看详情</p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 邀请占位 */}
      {inviteOpen && (
        <div
          onClick={() => setInviteOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.4)", zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--surface)", borderRadius: 13, padding: "28px 32px", width: 380, textAlign: "center" }}>
            <p style={SECTION_LABEL}>Coming Soon</p>
            <h3 style={{ margin: "0 0 8px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 19, fontWeight: 500, color: "var(--ink)" }}>
              邀请 / 批量邀请
            </h3>
            <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
              成员加入将改为邀请制（替代原「添加成员 / 导入」），功能建设中。
            </p>
            <button style={PRIMARY_BTN} onClick={() => setInviteOpen(false)}>知道了</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 成员详情 ─────────────────────────────────────────────────────────────────

function MemberDetail({
  member: m, depts, allMembers, tags, caps, busy, isSelf, onPatch, onRemove,
}: {
  member: Member;
  depts: Dept[];
  allMembers: Member[];
  tags: MemberTag[];
  caps: Caps;
  busy: boolean;
  isSelf: boolean;
  onPatch: (userId: string, body: Record<string, unknown>, apply: (m: Member) => Member) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
}) {
  const myDepts = depts.filter(d => d.memberUserIds.includes(m.userId));

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
            {m.status === "suspended" ? <Badge tone="red">已停用</Badge> : <Badge tone="green">在职</Badge>}
          </h2>
          <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--muted)" }}>
            {m.roles.join(" · ") || "无角色"}
          </p>
        </div>
      </div>

      {/* 角色（只读，入口在角色管理） */}
      <div style={{ marginBottom: 16 }}>
        <p style={SECTION_LABEL}>角色 <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>（在「角色管理」中调整）</span></p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {m.roles.length ? m.roles.map(r => <Badge key={r} tone="blue">{r}</Badge>) : <span style={{ fontSize: 12, color: "var(--muted)" }}>未指派</span>}
        </div>
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
        {caps.editMember ? (
          <select
            value={m.supervisorId ?? ""}
            disabled={busy}
            onChange={e => {
              const v = e.target.value || null;
              const sup = v ? allMembers.find(x => x.userId === v) : null;
              onPatch(m.userId, { supervisorId: v }, mm => ({ ...mm, supervisorId: v, supervisorName: sup?.name ?? null }));
            }}
            style={{ padding: "7px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", minWidth: 180 }}
          >
            <option value="">（无）</option>
            {allMembers.filter(x => x.userId !== m.userId).map(x => (
              <option key={x.userId} value={x.userId}>{x.name || x.userId.slice(0, 8)}</option>
            ))}
          </select>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink)" }}>{m.supervisorName ?? "（无）"}</p>
        )}
      </div>

      {/* 部门归属 */}
      <div style={{ marginBottom: 16 }}>
        <p style={SECTION_LABEL}>部门归属 <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>（在「部门」子页调整）</span></p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {myDepts.length ? myDepts.map(d => (
            <Badge key={d.id} tone={d.kind === "group" ? "amber" : "neutral"}>
              {d.name}{d.pocUserIds.includes(m.userId) ? " ★POC" : ""}
            </Badge>
          )) : <span style={{ fontSize: 12, color: "var(--muted)" }}>未分配</span>}
        </div>
      </div>

      {/* 联系方式（可见门裁剪：无权时 SSR 已置 null，此处整段隐藏） */}
      {caps.viewContact && (
        <div style={{ marginBottom: 16 }}>
          <p style={SECTION_LABEL}>联系方式</p>
          <p style={{ margin: "0 0 3px", fontSize: 13, color: "var(--ink)" }}>邮箱：{m.email ?? "（未登记）"}</p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink)" }}>电话：{m.phone ?? "（未登记）"}</p>
        </div>
      )}

      {/* 危险区 */}
      {caps.remove && !isSelf && (
        <div style={{ marginTop: 24, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <p style={{ ...SECTION_LABEL, color: "var(--danger)" }}>危险区</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={busy}
              onClick={() => onPatch(
                m.userId,
                { status: m.status === "suspended" ? "active" : "suspended" },
                mm => ({ ...mm, status: mm.status === "suspended" ? "active" : "suspended" }),
              )}
              style={{ ...SECONDARY_BTN, borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              {m.status === "suspended" ? "恢复在职" : "停用"}
            </button>
            <button
              disabled={busy}
              onClick={() => onRemove(m.userId)}
              style={{ ...PRIMARY_BTN, background: "var(--danger)", borderColor: "var(--danger)" }}
            >
              清退出项目
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 部门详情 ─────────────────────────────────────────────────────────────────

function DeptDetail({
  dept, depts, members, caps, busy, descendants, onPatch, onSaveMembers, onDelete,
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
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(dept.name);
  const [pickerOpen, setPickerOpen] = useState(false);

  const memberMap = new Map(members.map(m => [m.userId, m]));
  const blocked = descendants(dept.id);

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
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 18 }}>
          <div>
            <p style={SECTION_LABEL}>上级部门</p>
            <select
              value={dept.parentId ?? ""}
              disabled={busy}
              onChange={e => {
                const v = e.target.value || null;
                onPatch(dept.id, { parentId: v }, d => ({ ...d, parentId: v }));
              }}
              style={{ padding: "7px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", minWidth: 160 }}
            >
              <option value="">（顶级）</option>
              {depts.filter(d => !blocked.has(d.id)).map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <p style={SECTION_LABEL}>类型</p>
            <select
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
            </select>
          </div>
        </div>
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
            <select value={parentId} onChange={e => setParentId(e.target.value)} style={FIELD}>
              <option value="">（顶级）</option>
              {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select value={kind} onChange={e => setKind(e.target.value === "group" ? "group" : "dept")} style={FIELD}>
              <option value="dept">部门</option>
              <option value="group">用户组</option>
            </select>
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
