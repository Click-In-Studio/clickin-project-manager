"use client";

import { useState, useRef, useEffect } from "react";
import { match as pinyinMatch } from "pinyin-pro";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/db";
import type { EventDepartment } from "@/lib/event-db";
import { ROLE_GROUPS, PERMISSION_GROUPS, PERMISSION_LABELS, roleBasedPermission, type Permission } from "@/lib/roles";
// Search result returned by feishu-user-search API (local DB, includes raw contact info)
type SearchResult = {
  userId: string;
  openId: string;
  name: string;
  avatarUrl: string | null;
  enName?: string;
  hint?: string | null;
  email?: string | null;
  phone?: string | null;
};

const ROLE_ORDER = ROLE_GROUPS.flatMap((g) => g.roles);
const ALL_ROLE_GROUPS = ROLE_GROUPS;

function sortByFirstRole(members: MemberWithRoles[]): MemberWithRoles[] {
  return [...members].sort((a, b) => {
    const ai = a.roles.length ? ROLE_ORDER.indexOf(a.roles[0]) : Infinity;
    const bi = b.roles.length ? ROLE_ORDER.indexOf(b.roles[0]) : Infinity;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name, "zh");
  });
}

// ─── MemberCard ───────────────────────────────────────────────────────────────

function resolvePhoto(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("http")) return raw;
  return `${BASE_PATH}/api/media?token=${encodeURIComponent(raw)}`;
}

function MemberCard({
  member,
  canManage,
  isSelf,
  onManage,
  onEdit,
}: {
  member: MemberWithRoles;
  canManage: boolean;
  isSelf: boolean;
  onManage: () => void;
  onEdit: () => void;
}) {
  const photo = resolvePhoto(member.photoUrl) ?? member.avatarUrl;

  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden flex flex-col">
      <div className="aspect-[3/4] bg-zinc-100 flex items-center justify-center overflow-hidden">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt={member.name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-3xl font-medium text-zinc-300">{member.name[0]}</span>
        )}
      </div>

      <div className="px-3 py-3 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-1">
          <p className="text-sm font-semibold text-zinc-800 truncate">{member.name}</p>
          <div className="shrink-0 flex gap-0.5">
            {(canManage || isSelf) && (
              <button
                onClick={onEdit}
                className="rounded px-1.5 py-0.5 text-[11px] text-zinc-300 hover:text-zinc-500 hover:bg-zinc-50 transition-colors"
              >
                编辑
              </button>
            )}
            {canManage && (
              <button
                onClick={onManage}
                className="rounded px-1.5 py-0.5 text-[11px] text-zinc-300 hover:text-zinc-500 hover:bg-zinc-50 transition-colors"
              >
                权限
              </button>
            )}
          </div>
        </div>

        {member.roles.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {member.roles.map((r) => (
              <span key={r} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">
                {r}
              </span>
            ))}
          </div>
        )}

        {member.email && (
          <a href={`mailto:${member.email}`} className="text-xs text-zinc-400 hover:text-zinc-600 truncate">
            {member.email}
          </a>
        )}
        {member.phone && (
          <a href={`tel:${member.phone}`} className="text-xs text-zinc-400 hover:text-zinc-600">
            {member.phone}
          </a>
        )}
      </div>
    </div>
  );
}

// ─── PermissionsPanel ────────────────────────────────────────────────────────

function PermissionsPanel({
  productionId,
  member,
  overrides,
  onClose,
  onOverrideChange,
}: {
  productionId: string;
  member: MemberWithRoles;
  overrides: Record<string, boolean>;
  onClose: () => void;
  onOverrideChange: (perm: Permission, granted: boolean | null) => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);

  const setOverride = async (perm: Permission, granted: boolean | null) => {
    setSaving(perm);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/permissions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: member.userId, permission: perm, granted }),
      });
      onOverrideChange(perm, granted);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="relative h-full w-full max-w-sm bg-white shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-zinc-800">{member.name}</p>
            <p className="text-xs text-zinc-400 mt-0.5">
              {member.roles.length ? member.roles.join("、") : "暂无职位"}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-300 hover:text-zinc-500 text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {PERMISSION_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="mb-2 text-[11px] font-semibold tracking-widest text-zinc-300 uppercase">
                {group.label}
              </p>
              <div className="space-y-2">
                {group.perms.map((perm) => {
                  const roleValue = roleBasedPermission(perm, member.isAdmin, member.roles);
                  const override = perm in overrides ? overrides[perm] : null;
                  const isSaving = saving === perm;

                  return (
                    <div key={perm} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-700">{PERMISSION_LABELS[perm]}</p>
                        <p className="text-[11px] text-zinc-400">
                          职位默认：{roleValue ? "允许" : "禁止"}
                        </p>
                      </div>
                      <div className="shrink-0 flex rounded-lg border border-zinc-200 overflow-hidden text-[11px] font-medium">
                        {(["null", "true", "false"] as const).map((val) => {
                          const v = val === "null" ? null : val === "true";
                          const isActive = override === v;
                          return (
                            <button
                              key={val}
                              disabled={isSaving}
                              onClick={() => !isActive && setOverride(perm, v)}
                              className={`px-2 py-1 transition-colors ${
                                isActive
                                  ? val === "null"
                                    ? "bg-zinc-700 text-white"
                                    : val === "true"
                                    ? "bg-green-600 text-white"
                                    : "bg-red-500 text-white"
                                  : "text-zinc-400 hover:bg-zinc-50"
                              } disabled:opacity-50`}
                            >
                              {val === "null" ? "默认" : val === "true" ? "允许" : "禁止"}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── EditInfoPanel ────────────────────────────────────────────────────────────

function EditInfoPanel({
  productionId,
  member,
  canManage,
  onClose,
  onSaved,
  onDeleted,
}: {
  productionId: string;
  member: MemberWithRoles;
  canManage: boolean;
  onClose: () => void;
  onSaved: (updated: Partial<MemberWithRoles>) => void;
  onDeleted: () => void;
}) {
  const [email, setEmail] = useState(member.email ?? "");
  const [phone, setPhone] = useState(member.phone ?? "");
  const [photoUrl, setPhotoUrl] = useState(member.photoUrl ?? "");
  const [selectedRoles, setSelectedRoles] = useState<string[]>(member.roles);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { userId: member.userId };
      if (canManage) body.roles = selectedRoles;
      body.email = email.trim() || null;
      body.phone = phone.trim() || null;
      body.photoUrl = photoUrl.trim() || null;

      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        onSaved({
          roles: canManage ? selectedRoles : member.roles,
          email: email.trim() || null,
          phone: phone.trim() || null,
          photoUrl: photoUrl.trim() || null,
        });
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`确定移除「${member.name}」吗？此操作不可撤销。`)) return;
    setDeleting(true);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: member.userId }),
      });
      onDeleted();
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="relative h-full w-full max-w-sm bg-white shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-zinc-800">{member.name}</p>
            <p className="text-xs text-zinc-400 mt-0.5">编辑信息</p>
          </div>
          <button onClick={onClose} className="text-zinc-300 hover:text-zinc-500 text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Contact info */}
          <div className="space-y-3">
            <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase">联系方式</p>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">邮箱</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                type="email"
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">手机</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+86 138..."
                type="tel"
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">照片链接</label>
              <input
                value={photoUrl}
                onChange={(e) => setPhotoUrl(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
              />
            </div>
          </div>

          {/* Roles — admin only */}
          {canManage && (
            <div className="space-y-3">
              <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase">职位</p>
              {ALL_ROLE_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="text-[11px] text-zinc-400 mb-1.5">{group.label}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.roles.map((role) => {
                      const active = selectedRoles.includes(role);
                      return (
                        <button
                          key={role}
                          onClick={() => toggleRole(role)}
                          className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                            active
                              ? "bg-zinc-800 text-white"
                              : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                          }`}
                        >
                          {role}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-zinc-100 px-5 py-4 flex items-center gap-3">
          {canManage && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-500 hover:bg-red-50 disabled:opacity-30 transition-colors"
            >
              {deleting ? "移除中…" : "移除"}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="ml-auto rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-30 transition-colors"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AddMemberPanel ───────────────────────────────────────────────────────────

function AddMemberPanel({
  productionId,
  existingUserIds,
  onClose,
  onAdded,
}: {
  productionId: string;
  existingUserIds: Set<string>;
  onClose: () => void;
  onAdded: (member: MemberWithRoles) => void;
}) {
  const [query, setQuery] = useState("");
  const [allUsers, setAllUsers] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAllUsers = async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/feishu-user-search`);
      const data = await res.json();
      if (data.error) setError(data.error);
      else setAllUsers(data.users ?? []);
    } catch {
      setError("加载通讯录失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAllUsers(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const results = query.trim()
    ? allUsers.filter((u) =>
        u.name.includes(query) || pinyinMatch(u.name, query.toLowerCase()) != null
      )
    : allUsers;

  const syncAndSearch = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/admin/sync-feishu-users`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) { setError(data.error ?? "同步失败"); return; }
      setLoading(true);
      await loadAllUsers();
    } catch {
      setError("同步失败，请重试");
    } finally {
      setSyncing(false);
    }
  };

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const handleAdd = async () => {
    if (!selected) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: selected.userId,
          name: selected.name,
          avatarUrl: selected.avatarUrl,
          email: selected.email ?? null,
          phone: selected.phone ?? null,
          roles: selectedRoles,
        }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error ?? "添加失败"); return; }
      onAdded({
        userId: selected.userId,
        openId: selected.openId,
        name: selected.name,
        avatarUrl: selected.avatarUrl,
        isAdmin: false,
        email: selected.email ?? null,
        phone: selected.phone ?? null,
        roles: selectedRoles,
        photoUrl: null,
      });
      onClose();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="relative h-full w-full max-w-sm bg-white shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <p className="text-sm font-semibold text-zinc-800">添加人员</p>
          <button onClick={onClose} className="text-zinc-300 hover:text-zinc-500 text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Search input + always-visible sync button */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">按姓名或拼音搜索</label>
            <input
              autoFocus
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
              placeholder="输入姓名、全拼或首拼…"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
            />
            <div className="flex items-center justify-between mt-1.5">
              <p className="text-[11px] text-zinc-300">搜索本地通讯录</p>
              <button
                onClick={syncAndSearch}
                disabled={syncing || loading}
                className="text-[11px] text-zinc-400 hover:text-zinc-700 disabled:opacity-40 underline underline-offset-2 transition-colors"
              >
                {syncing ? "同步中…" : "同步飞书通讯录"}
              </button>
            </div>
          </div>

          {/* Search results */}
          {!selected && (
            <div className="space-y-1">
              {(loading || syncing) && (
                <p className="text-xs text-zinc-300 text-center py-3">
                  {syncing ? "正在同步飞书通讯录…" : "加载中…"}
                </p>
              )}
              {!loading && !syncing && error && <p className="text-xs text-red-500">{error}</p>}
              {!loading && !syncing && results.map((u) => {
                const alreadyAdded = existingUserIds.has(u.userId);
                return (
                  <button
                    key={u.userId}
                    disabled={alreadyAdded}
                    onClick={() => { setSelected(u); setError(null); }}
                    className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      alreadyAdded
                        ? "opacity-40 cursor-not-allowed"
                        : "hover:bg-zinc-50"
                    }`}
                  >
                    {u.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u.avatarUrl} alt={u.name} className="w-9 h-9 rounded-full object-cover shrink-0" />
                    ) : (
                      <span className="w-9 h-9 rounded-full bg-zinc-100 flex items-center justify-center text-sm text-zinc-400 shrink-0">
                        {u.name[0]}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-800">
                        {u.name}
                        {u.enName && <span className="ml-1.5 text-zinc-400 text-xs">{u.enName}</span>}
                      </p>
                      {u.hint && <p className="text-xs text-zinc-400 truncate">{u.hint}</p>}
                      {alreadyAdded && <p className="text-xs text-zinc-300">已在人员列表中</p>}
                    </div>
                  </button>
                );
              })}
              {!loading && !syncing && !error && query.trim() && results.length === 0 && (
                <p className="text-xs text-zinc-300 text-center py-3">未找到「{query}」，试试同步通讯录</p>
              )}
            </div>
          )}

          {/* Selected user + role assignment */}
          {selected && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl bg-zinc-50 px-3 py-3">
                {selected.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selected.avatarUrl} alt={selected.name} className="w-10 h-10 rounded-full object-cover shrink-0" />
                ) : (
                  <span className="w-10 h-10 rounded-full bg-zinc-200 flex items-center justify-center text-sm text-zinc-500 shrink-0">
                    {selected.name[0]}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-zinc-800">{selected.name}</p>
                  {selected.hint && <p className="text-xs text-zinc-400">{selected.hint}</p>}
                </div>
                <button
                  onClick={() => { setSelected(null); setSelectedRoles([]); }}
                  className="text-xs text-zinc-300 hover:text-zinc-500"
                >
                  重选
                </button>
              </div>

              <div className="space-y-3">
                <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase">职位（可选）</p>
                {ALL_ROLE_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="text-[11px] text-zinc-400 mb-1.5">{group.label}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {group.roles.map((role) => {
                        const active = selectedRoles.includes(role);
                        return (
                          <button
                            key={role}
                            onClick={() => toggleRole(role)}
                            className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                              active
                                ? "bg-zinc-800 text-white"
                                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                            }`}
                          >
                            {role}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          )}
        </div>

        {selected && (
          <div className="border-t border-zinc-100 px-5 py-4">
            <button
              onClick={handleAdd}
              disabled={adding}
              className="w-full rounded-lg bg-zinc-800 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-30 transition-colors"
            >
              {adding ? "添加中…" : `添加「${selected.name}」`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ImportPanel ──────────────────────────────────────────────────────────────

function ImportPanel({
  productionId,
  onImported,
}: {
  productionId: string;
  onImported: (members: MemberWithRoles[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [wikiUrl, setWikiUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    ok?: boolean;
    stats?: { matched: number; created: number; notFound: string[] };
    warnings?: string[];
    error?: string;
    details?: string[];
  } | null>(null);

  const submit = async () => {
    if (!wikiUrl.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/import-contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wikiUrl: wikiUrl.trim() }),
      });
      const data = await res.json();
      setResult(data);
      if (data.ok) {
        const r2 = await fetch(`${BASE_PATH}/api/production/${productionId}/contacts`);
        if (r2.ok) onImported(await r2.json());
      }
    } catch {
      setResult({ error: "网络错误，请重试" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
      >
        <span>导入 / 更新人员</span>
        <span className="text-zinc-300 text-base">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-3 border-t border-zinc-100">
          <p className="pt-3 text-xs text-zinc-400">
            粘贴飞书 contact sheet 的 Wiki 链接，表格须包含「姓名」「职位」列。
          </p>
          <input
            value={wikiUrl}
            onChange={(e) => { setWikiUrl(e.target.value); setResult(null); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="https://xxx.feishu.cn/wiki/..."
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none placeholder:text-zinc-300 focus:border-zinc-400"
          />
          <button
            onClick={submit}
            disabled={!wikiUrl.trim() || loading}
            className="w-full rounded-lg bg-zinc-800 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-30"
          >
            {loading ? "导入中…" : "开始导入"}
          </button>
          {result && (
            <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2.5 space-y-1.5 text-xs">
              {result.error ? (
                <p className="text-red-500 font-medium">{result.error}</p>
              ) : (
                <p className="text-green-600 font-medium">
                  导入完成：匹配 {result.stats?.matched} 人，新增 {result.stats?.created} 人
                  {result.stats?.notFound.length ? `，${result.stats.notFound.length} 人未找到` : ""}
                </p>
              )}
              {result.stats?.notFound.length ? (
                <p className="text-zinc-400">未找到：{result.stats.notFound.join("、")}</p>
              ) : null}
              {result.details?.map((d, i) => <p key={i} className="text-zinc-400">{d}</p>)}
              {result.warnings?.map((w, i) => <p key={i} className="text-amber-500">{w}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DepartmentPanel ──────────────────────────────────────────────────────────

function DepartmentPanel({
  productionId,
  initialDepartments,
  members,
}: {
  productionId: string;
  initialDepartments: EventDepartment[];
  members: MemberWithRoles[];
}) {
  const [open, setOpen] = useState(false);
  const [departments, setDepartments] = useState<EventDepartment[]>(initialDepartments);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [creatingKind, setCreatingKind] = useState<"dept" | "group" | null>(null);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const depts = departments.filter((d) => d.kind === "dept");
  const groups = departments.filter((d) => d.kind === "group");

  const handleCreate = async (kind: "dept" | "group") => {
    if (!newName.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/departments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), kind }),
      });
      const data = await res.json();
      if (data.department) {
        setDepartments((prev) => [...prev, data.department]);
        setNewName("");
        setCreatingKind(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCreateDeptChat = async (dept: EventDepartment) => {
    if (!confirm(`确定为「${dept.name}」创建飞书群吗？`)) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/departments/${dept.id}/chat`, {
      method: "POST",
    });
    const data = await res.json();
    if (data.chatId) {
      setDepartments(prev => prev.map(d => d.id === dept.id ? { ...d, chatId: data.chatId } : d));
    } else {
      alert(data.error ?? "建群失败");
    }
  };

  const handleSaveName = async (id: string) => {
    if (!editName.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/departments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
      const data = await res.json();
      if (data.department) {
        setDepartments((prev) => prev.map((d) => (d.id === id ? data.department : d)));
        setEditingId(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除？删除后无法恢复。")) return;
    await fetch(`${BASE_PATH}/api/production/${productionId}/departments/${id}`, { method: "DELETE" });
    setDepartments((prev) => prev.filter((d) => d.id !== id));
    if (expandedId === id) setExpandedId(null);
    if (editingId === id) setEditingId(null);
  };

  const saveDeptMembers = async (dept: EventDepartment, newEntries: { userId: string; isMember: boolean; isPoc: boolean }[]) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/departments/${dept.id}/members`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: newEntries }),
    });
    const data = await res.json();
    if (data.department) {
      setDepartments((prev) => prev.map((d) => (d.id === dept.id ? data.department : d)));
    }
  };

  function buildEntries(dept: EventDepartment) {
    const allIds = new Set([...dept.memberUserIds, ...dept.pocUserIds]);
    return new Map([...allIds].map(id => [id, {
      userId: id,
      isMember: dept.memberUserIds.includes(id),
      isPoc: dept.pocUserIds.includes(id),
    }]));
  }

  const handleToggleMember = (dept: EventDepartment, userId: string) => {
    const entries = buildEntries(dept);
    const isMember = dept.memberUserIds.includes(userId);
    if (isMember) {
      entries.delete(userId);
    } else {
      entries.set(userId, { userId, isMember: true, isPoc: false });
    }
    saveDeptMembers(dept, [...entries.values()]);
  };

  const handleTogglePoc = (dept: EventDepartment, userId: string) => {
    const entries = buildEntries(dept);
    const isPoc = dept.pocUserIds.includes(userId);
    const current = entries.get(userId) ?? { userId, isMember: false, isPoc: false };
    const newIsPoc = !isPoc;
    if (!newIsPoc && !current.isMember) {
      entries.delete(userId);
    } else {
      entries.set(userId, { ...current, isPoc: newIsPoc });
    }
    saveDeptMembers(dept, [...entries.values()]);
  };

  const renderRow = (dept: EventDepartment) => {
    const isExpanded = expandedId === dept.id;
    const isEditing = editingId === dept.id;
    const summary = dept.memberUserIds.length > 0
      ? `${dept.memberUserIds.length} 位成员${dept.pocUserIds.length > 0 ? `，${dept.pocUserIds.length} 位 POC` : ""}`
      : "";
    const filtered = search
      ? members.filter((m) => m.name.includes(search) || m.roles.some((r) => r.includes(search)))
      : members;

    return (
      <div key={dept.id} className="border-b border-zinc-100 last:border-0">
        <div className="flex items-center gap-2 px-3 py-2.5">
          {isEditing ? (
            <>
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveName(dept.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="flex-1 rounded border border-zinc-300 px-2 py-0.5 text-sm outline-none focus:border-zinc-500"
              />
              <button
                onClick={() => handleSaveName(dept.id)}
                disabled={saving}
                className="text-xs text-zinc-600 hover:text-zinc-800 disabled:opacity-30"
              >
                保存
              </button>
              <button onClick={() => setEditingId(null)} className="text-xs text-zinc-300 hover:text-zinc-500">
                取消
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => { setExpandedId(isExpanded ? null : dept.id); setSearch(""); }}
                className="flex-1 flex items-center gap-2 text-left min-w-0"
              >
                <span className="text-sm text-zinc-700 truncate">{dept.name}</span>
                {summary && (
                  <span className="shrink-0 text-[11px] text-zinc-400">{summary}</span>
                )}
                <span className="ml-auto shrink-0 text-zinc-300 text-xs">{isExpanded ? "▲" : "▼"}</span>
              </button>
              <button
                onClick={() => { setEditingId(dept.id); setEditName(dept.name); setExpandedId(null); }}
                className="shrink-0 text-[11px] text-zinc-300 hover:text-zinc-500 px-1 transition-colors"
              >
                改名
              </button>
              {dept.chatId ? (
                <span className="shrink-0 text-[10px] bg-blue-50 text-blue-500 rounded px-1.5 py-0.5">
                  飞书群
                </span>
              ) : (
                <button
                  onClick={() => handleCreateDeptChat(dept)}
                  className="shrink-0 text-[11px] text-zinc-300 hover:text-blue-500 px-1 transition-colors"
                  title="创建飞书群"
                >
                  建群
                </button>
              )}
              <button
                onClick={() => handleDelete(dept.id)}
                className="shrink-0 text-[11px] text-zinc-300 hover:text-red-400 px-1 transition-colors"
              >
                删除
              </button>
            </>
          )}
        </div>

        {isExpanded && (
          <div className="px-3 pb-3 border-t border-zinc-50">
            <div className="flex items-center pt-2.5 pb-1.5 pr-1">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索姓名或职位…"
                className="flex-1 rounded border border-zinc-200 px-2 py-1.5 text-xs outline-none focus:border-zinc-400"
              />
              <div className="flex gap-3 ml-3 shrink-0">
                <span className="text-[11px] font-medium text-zinc-400 w-8 text-center">成员</span>
                <span className="text-[11px] font-medium text-zinc-400 w-8 text-center">POC</span>
              </div>
            </div>

            <div className="space-y-0.5 max-h-52 overflow-y-auto mt-1">
              {filtered.map((m) => {
                const isMember = dept.memberUserIds.includes(m.userId);
                const isPoc = dept.pocUserIds.includes(m.userId);
                return (
                  <div
                    key={m.userId}
                    className={`flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors ${
                      isMember ? "bg-zinc-50" : ""
                    }`}
                  >
                    <span className="flex-1 truncate text-sm text-zinc-700 font-medium">{m.name}</span>
                    {m.roles.length > 0 && (
                      <span className="text-[11px] text-zinc-400 shrink-0 mr-1">{m.roles[0]}</span>
                    )}
                    <button
                      onClick={() => handleToggleMember(dept, m.userId)}
                      className={`w-8 h-5 rounded-full transition-colors shrink-0 ${
                        isMember ? "bg-zinc-700" : "bg-zinc-200 hover:bg-zinc-300"
                      }`}
                      aria-label={isMember ? "移除成员" : "添加成员"}
                    >
                      <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform mx-auto ${
                        isMember ? "translate-x-1.5" : "-translate-x-1.5"
                      }`} />
                    </button>
                    <button
                      onClick={() => handleTogglePoc(dept, m.userId)}
                      className={`w-8 h-5 rounded-full transition-colors shrink-0 ${
                        isPoc ? "bg-amber-500" : "bg-zinc-200 hover:bg-zinc-300"
                      }`}
                      aria-label={isPoc ? "取消 POC" : "设为 POC"}
                    >
                      <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform mx-auto ${
                        isPoc ? "translate-x-1.5" : "-translate-x-1.5"
                      }`} />
                    </button>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="text-xs text-zinc-300 py-2 text-center">没有匹配的人员</p>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderSection = (label: string, kind: "dept" | "group", items: EventDepartment[]) => (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase">{label}</p>
        <button
          onClick={() => { setCreatingKind(kind); setNewName(""); setExpandedId(null); }}
          className="text-[11px] text-zinc-400 hover:text-zinc-700 transition-colors"
        >
          + 新建
        </button>
      </div>
      <div className="rounded-xl border border-zinc-100 overflow-hidden bg-white">
        {items.length === 0 && creatingKind !== kind && (
          <p className="px-3 py-3 text-xs text-zinc-300">暂无{label}</p>
        )}
        {items.map(renderRow)}
        {creatingKind === kind && (
          <div className="flex items-center gap-2 border-t border-zinc-100 px-3 py-2.5">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate(kind);
                if (e.key === "Escape") setCreatingKind(null);
              }}
              placeholder={`${label}名称`}
              className="flex-1 rounded border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-zinc-400"
            />
            <button
              onClick={() => handleCreate(kind)}
              disabled={saving || !newName.trim()}
              className="text-xs text-zinc-600 hover:text-zinc-800 disabled:opacity-30"
            >
              保存
            </button>
            <button onClick={() => setCreatingKind(null)} className="text-xs text-zinc-300 hover:text-zinc-500">
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
      >
        <span>
          部门 & 用户组
          {departments.length > 0 && (
            <span className="ml-2 text-xs font-normal text-zinc-400">{departments.length} 个</span>
          )}
        </span>
        <span className="text-zinc-300 text-base">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-zinc-100 pt-4">
          {renderSection("部门", "dept", depts)}
          {renderSection("用户组", "group", groups)}
        </div>
      )}
    </div>
  );
}

// ─── ContactsClient ───────────────────────────────────────────────────────────

type Props = {
  productionId: string;
  productionName: string;
  initialMembers: MemberWithRoles[];
  canImport: boolean;
  canManage: boolean;
  myUserId: string;
  initialOverrides: Record<string, Record<string, boolean>>;
  canManageDepts: boolean;
  initialDepartments: EventDepartment[];
};

export default function ContactsClient({
  productionId,
  productionName,
  initialMembers,
  canImport,
  canManage,
  myUserId,
  initialOverrides,
  canManageDepts,
  initialDepartments,
}: Props) {
  const [members, setMembers] = useState<MemberWithRoles[]>(initialMembers);
  const [overrides, setOverrides] = useState<Record<string, Record<string, boolean>>>(initialOverrides);
  const [managingUserId, setManagingOpenId] = useState<string | null>(null);
  const [editingUserId, setEditingOpenId] = useState<string | null>(null);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const handleSyncAll = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/admin/sync-feishu-users`, { method: "POST" });
      const data = await res.json();
      if (data.ok) setSyncResult(`已同步 ${data.total} 位用户`);
      else setSyncResult(data.error ?? "同步失败");
    } catch {
      setSyncResult("同步失败");
    } finally {
      setSyncing(false);
    }
  };

  const sorted = sortByFirstRole(members);
  const managingMember = managingUserId ? members.find((m) => m.userId === managingUserId) ?? null : null;
  const editingMember = editingUserId ? members.find((m) => m.userId === editingUserId) ?? null : null;
  const existingUserIds = new Set(members.map((m) => m.userId));

  const handleOverrideChange = (userId: string, perm: Permission, granted: boolean | null) => {
    setOverrides((prev) => {
      const next = { ...prev, [userId]: { ...prev[userId] } };
      if (granted === null) {
        delete next[userId][perm];
      } else {
        next[userId][perm] = granted;
      }
      return next;
    });
  };

  const handleMemberSaved = (userId: string, updated: Partial<MemberWithRoles>) => {
    setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, ...updated } : m)));
  };

  const handleMemberDeleted = (userId: string) => {
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
  };

  const handleMemberAdded = (member: MemberWithRoles) => {
    setMembers((prev) => [...prev, member]);
  };

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <Link href={`/production/${productionId}`} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回
          </Link>
          <div className="flex items-center gap-2">
            {canManage && (
              <>
                <button
                  onClick={handleSyncAll}
                  disabled={syncing}
                  title={syncResult ?? "同步飞书全员到本地通讯录"}
                  className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-200 disabled:opacity-40 transition-colors"
                >
                  {syncing ? "同步中…" : "同步通讯录"}
                </button>
                <button
                  onClick={() => setShowAddPanel(true)}
                  className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 transition-colors"
                >
                  + 添加人员
                </button>
              </>
            )}
            <div className="text-right ml-2">
              <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">People</p>
              <p className="text-sm font-bold text-zinc-500">{productionName}</p>
            </div>
          </div>
        </div>

        {canImport && (
          <ImportPanel productionId={productionId} onImported={setMembers} />
        )}

        {canManageDepts && (
          <DepartmentPanel
            productionId={productionId}
            initialDepartments={initialDepartments}
            members={members}
          />
        )}

        {sorted.length === 0 ? (
          <p className="text-center text-sm text-zinc-300 py-16">暂无人员</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {sorted.map((m) => (
              <MemberCard
                key={m.userId}
                member={m}
                canManage={canManage}
                isSelf={m.userId === myUserId}
                onManage={() => setManagingOpenId(m.userId)}
                onEdit={() => setEditingOpenId(m.userId)}
              />
            ))}
          </div>
        )}
      </div>

      {managingMember && (
        <PermissionsPanel
          productionId={productionId}
          member={managingMember}
          overrides={overrides[managingMember.userId] ?? {}}
          onClose={() => setManagingOpenId(null)}
          onOverrideChange={(perm, granted) => handleOverrideChange(managingMember.userId, perm, granted)}
        />
      )}

      {editingMember && (
        <EditInfoPanel
          productionId={productionId}
          member={editingMember}
          canManage={canManage}
          onClose={() => setEditingOpenId(null)}
          onSaved={(updated) => handleMemberSaved(editingMember.userId, updated)}
          onDeleted={() => handleMemberDeleted(editingMember.userId)}
        />
      )}

      {showAddPanel && (
        <AddMemberPanel
          productionId={productionId}
          existingUserIds={existingUserIds}
          onClose={() => setShowAddPanel(false)}
          onAdded={handleMemberAdded}
        />
      )}
    </div>
  );
}
