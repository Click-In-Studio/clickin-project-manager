"use client";

import { useMemo, useState } from "react";
import PageHeader, { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import Badge from "@/components/Badge";
import AdminModal from "@/components/AdminModal";
import MemberPickerModal, { type PickerDept } from "@/components/MemberPickerModal";
import styles from "@/components/my-pages.module.css";
import { userAvatarSrc } from "@/lib/avatar-url";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberStatus } from "@/lib/member-status-shared";
import { isInactiveMember } from "@/lib/member-status-shared";

type Role = { id: string; name: string };

type Member = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  photoUrl: string | null;
  roles: string[];
  tags: string[];
  email: string | null;
  phone: string | null;
  status: MemberStatus;
};

type Caps = { create: boolean; rename: boolean; remove: boolean; assign: boolean };

type Props = {
  productionId: string;
  productionName: string;
  initialRoles: Role[];
  members: Member[];
  depts: PickerDept[];
  owner: { userId: string | null; name: string | null };
  caps: Caps;
};

const SECTION_LABEL: React.CSSProperties = {
  margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
  textTransform: "uppercase", color: "var(--stage)",
};

const PRODUCER = "制作人";

function Avatar({ m, size }: { m: Member; size: number }) {
  const url = m.photoUrl || userAvatarSrc(m.userId, m.avatarUrl);
  return url ? (
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

export default function AdminRolesClient({
  productionId, productionName, initialRoles, members: initialMembers, depts, owner, caps,
}: Props) {
  const [roles, setRoles] = useState<Role[]>(initialRoles);
  const [members, setMembers] = useState<Member[]>(initialMembers);
  // "owner" 是特殊选择态（系统身份，非 production_role 行）
  const [selectedId, setSelectedId] = useState<string | "owner" | null>(
    initialRoles.find(r => r.name === PRODUCER)?.id ?? initialRoles[0]?.id ?? null,
  );
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedRole = selectedId !== "owner" ? roles.find(r => r.id === selectedId) ?? null : null;
  const roleMembers = useMemo(
    () => (selectedRole ? members.filter(m => m.roles.includes(selectedRole.name)) : []),
    [members, selectedRole],
  );
  const countByRole = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members) for (const r of m.roles) map.set(r, (map.get(r) ?? 0) + 1);
    return map;
  }, [members]);

  const customRoles = roles.filter(r => r.name !== PRODUCER);
  const producerRole = roles.find(r => r.name === PRODUCER) ?? null;

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

  async function createRole() {
    const name = newName.trim();
    if (!name) return;
    const data = await api(`/roles`, { method: "POST", body: JSON.stringify({ name }) });
    if (data?.role) {
      const r = data.role as Role;
      setRoles(prev => [...prev, { id: r.id, name: r.name }]);
      setSelectedId(r.id);
      setNewName(""); setCreating(false);
    }
  }

  async function renameRole(role: Role, name: string) {
    if (await api(`/roles/${role.id}`, { method: "PATCH", body: JSON.stringify({ name }) })) {
      setRoles(prev => prev.map(r => (r.id === role.id ? { ...r, name } : r)));
      setMembers(prev => prev.map(m => ({
        ...m,
        roles: m.roles.map(rn => (rn === role.name ? name : rn)),
      })));
    }
  }

  async function deleteRole(role: Role) {
    const n = countByRole.get(role.name) ?? 0;
    if (!confirm(n > 0 ? `「${role.name}」仍有 ${n} 名成员，删除后将从这些成员移除该角色。确认删除？` : `确认删除「${role.name}」？`)) return;
    if (await api(`/roles/${role.id}`, { method: "DELETE" })) {
      setRoles(prev => prev.filter(r => r.id !== role.id));
      setMembers(prev => prev.map(m => ({ ...m, roles: m.roles.filter(rn => rn !== role.name) })));
      setSelectedId(prev => (prev === role.id ? null : prev));
    }
  }

  async function toggleMember(role: Role, m: Member) {
    const has = m.roles.includes(role.name);
    const nextRoles = has ? m.roles.filter(r => r !== role.name) : [...m.roles, role.name];
    if (await api(`/members`, { method: "PATCH", body: JSON.stringify({ userId: m.userId, roles: nextRoles }) })) {
      setMembers(prev => prev.map(x => (x.userId === m.userId ? { ...x, roles: nextRoles } : x)));
    }
  }

  async function assignMembers(role: Role, userIds: string[]) {
    for (const userId of userIds) {
      const m = members.find(x => x.userId === userId);
      if (!m || m.roles.includes(role.name)) continue;
      await toggleMember(role, m);
    }
  }

  function roleRow(role: Role, opts: { system?: boolean } = {}) {
    const active = selectedId === role.id;
    return (
      <button
        key={role.id}
        onClick={() => setSelectedId(role.id)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "8px 10px", borderRadius: 9, border: "none", cursor: "pointer",
          background: active ? "var(--ink)" : "transparent", textAlign: "left",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: active ? "#fff" : "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {role.name}
        </span>
        {opts.system && <Badge tone="amber">系统</Badge>}
        <span style={{ fontSize: 10, color: active ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
          {countByRole.get(role.name) ?? 0} 人
        </span>
      </button>
    );
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title="角色管理" side="stage" />

      {/* 摘要 */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(roles.length), "角色", "含系统角色"],
          [String(members.filter(m => m.roles.length > 0).length), "已指派成员", `共 ${members.length} 名成员`],
          [String(members.filter(m => m.roles.length === 0).length), "未指派", "无角色成员"],
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

      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

      <section style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22,
        height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column",
      }}>
        <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
          <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
            {/* 左：角色列表 */}
            <div className={`${styles.splitPane} ${styles.splitList}`}>
              <div style={{ paddingRight: 16 }}>
                <p style={{ ...SECTION_LABEL, marginTop: 2 }}>系统角色</p>
                {/* Owner 特殊行 */}
                <button
                  onClick={() => setSelectedId("owner")}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%",
                    padding: "8px 10px", borderRadius: 9, border: "none", cursor: "pointer",
                    background: selectedId === "owner" ? "var(--ink)" : "transparent", textAlign: "left",
                  }}
                >
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: selectedId === "owner" ? "#fff" : "var(--ink)" }}>
                    Owner
                  </span>
                  <Badge tone="amber">系统</Badge>
                  <span style={{ fontSize: 10, color: selectedId === "owner" ? "rgba(255,255,255,.6)" : "var(--muted)" }}>1 人</span>
                </button>
                {producerRole && roleRow(producerRole, { system: true })}

                <p style={{ ...SECTION_LABEL, marginTop: 14 }}>项目角色</p>
                {customRoles.map(r => roleRow(r))}
                {customRoles.length === 0 && (
                  <p style={{ fontSize: 12, color: "var(--muted)", padding: "6px 10px" }}>暂无自定义角色</p>
                )}

                {caps.create && (
                  <button style={{ ...SECONDARY_BTN, width: "100%", marginTop: 10 }} onClick={() => setCreating(true)}>
                    ＋ 新建角色
                  </button>
                )}
              </div>
            </div>

            {/* 右：详情 */}
            <div className={`${styles.splitPane} ${styles.splitDetail}`}>
              {selectedId === "owner" ? (
                <OwnerDetail owner={owner} members={members} />
              ) : selectedRole ? (
                <RoleDetail
                  key={selectedRole.id}
                  role={selectedRole}
                  isProducer={selectedRole.name === PRODUCER}
                  members={members}
                  depts={depts}
                  roleMembers={roleMembers}
                  caps={caps}
                  busy={busy}
                  onRename={renameRole}
                  onDelete={deleteRole}
                  onToggleMember={toggleMember}
                  onAssignMembers={assignMembers}
                />
              ) : (
                <p style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧角色查看详情</p>
              )}
            </div>
          </div>
        </div>
      </section>

      {creating && (
        <AdminModal kicker="组织架构" title="新建角色" onClose={() => { setCreating(false); setNewName(""); }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              value={newName} onChange={e => setNewName(e.target.value)} placeholder="角色名称"
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") createRole(); }}
              style={{ padding: "9px 11px", fontSize: 13, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={SECONDARY_BTN} onClick={() => { setCreating(false); setNewName(""); }}>取消</button>
              <button style={PRIMARY_BTN} disabled={busy || !newName.trim()} onClick={createRole}>创建</button>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  );
}

function OwnerDetail({ owner, members }: { owner: { userId: string | null; name: string | null }; members: Member[] }) {
  const m = owner.userId ? members.find(x => x.userId === owner.userId) ?? null : null;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>Owner</h2>
        <Badge tone="amber">系统角色 · 不可变更</Badge>
      </div>
      <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
        Owner 是项目的最终负责人，拥有全部权限（代码旁路，不走授权行）。
        每个项目有且仅有一位 Owner；转让在「危险操作」中进行。
      </p>
      <p style={SECTION_LABEL}>当前 Owner</p>
      {m ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar m={m} size={36} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{m.name}</span>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink)" }}>{owner.name ?? "（未设置）"}</p>
      )}
    </div>
  );
}

function RoleDetail({
  role, isProducer, members, depts, roleMembers, caps, busy, onRename, onDelete, onToggleMember, onAssignMembers,
}: {
  role: Role;
  isProducer: boolean;
  members: Member[];
  depts: PickerDept[];
  roleMembers: Member[];
  caps: Caps;
  busy: boolean;
  onRename: (role: Role, name: string) => Promise<void>;
  onDelete: (role: Role) => Promise<void>;
  onToggleMember: (role: Role, m: Member) => Promise<void>;
  onAssignMembers: (role: Role, userIds: string[]) => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(role.name);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        {renaming && !isProducer ? (
          <>
            <input
              value={nameDraft} onChange={e => setNameDraft(e.target.value)}
              style={{ fontSize: 17, fontFamily: 'Georgia, "Noto Serif SC", serif', padding: "5px 9px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}
            />
            <button style={PRIMARY_BTN} disabled={busy || !nameDraft.trim()}
              onClick={async () => { await onRename(role, nameDraft.trim()); setRenaming(false); }}>
              保存
            </button>
            <button style={SECONDARY_BTN} onClick={() => { setNameDraft(role.name); setRenaming(false); }}>取消</button>
          </>
        ) : (
          <>
            <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>{role.name}</h2>
            {isProducer && <Badge tone="amber">系统角色 · 不可改名/删除</Badge>}
            {!isProducer && caps.rename && (
              <button style={{ ...SECONDARY_BTN, padding: "4px 10px", fontSize: 11 }} onClick={() => setRenaming(true)}>改名</button>
            )}
          </>
        )}
      </div>

      {isProducer && (
        <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
          制作人是结构性系统角色（通配授权区间的宿主）。其权限配置与人事任免在「管理员设置」中进行。
        </p>
      )}

      <p style={SECTION_LABEL}>成员（{roleMembers.length}）</p>
      {roleMembers.map(m => (
        <div key={m.userId} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
          <Avatar m={m} size={26} />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: isInactiveMember(m.status) ? "var(--muted)" : "var(--ink)", textDecoration: isInactiveMember(m.status) ? "line-through" : undefined }}>
            {m.name || "（未命名）"}
          </span>
          {!isProducer && caps.assign && (
            <button
              disabled={busy}
              onClick={() => onToggleMember(role, m)}
              style={{ ...SECONDARY_BTN, padding: "3px 9px", fontSize: 10, borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              移除
            </button>
          )}
        </div>
      ))}
      {roleMembers.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)" }}>暂无成员</p>}

      {!isProducer && caps.assign && (
        <button style={{ ...SECONDARY_BTN, marginTop: 12 }} onClick={() => setPickerOpen(true)}>
          ＋ 指派角色
        </button>
      )}
      {pickerOpen && (
        <MemberPickerModal
          kicker="组织架构"
          title={`指派「${role.name}」`}
          confirmLabel="指派角色"
          members={members}
          depts={depts}
          excludeUserIds={roleMembers.map(m => m.userId)}
          busy={busy}
          onClose={() => setPickerOpen(false)}
          onConfirm={async (userIds) => {
            await onAssignMembers(role, userIds);
            setPickerOpen(false);
          }}
        />
      )}

      {!isProducer && caps.remove && (
        <div style={{ marginTop: 24, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <p style={{ ...SECTION_LABEL, color: "var(--danger)" }}>危险区</p>
          <button
            disabled={busy}
            onClick={() => onDelete(role)}
            style={{ ...SECONDARY_BTN, borderColor: "var(--danger)", color: "var(--danger)" }}
          >
            删除角色
          </button>
        </div>
      )}
    </div>
  );
}
