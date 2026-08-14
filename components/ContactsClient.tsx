"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import PageHeader, { PRIMARY_BTN } from "@/components/PageHeader";
import { match as pinyinMatch } from "pinyin-pro";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/db";
import { ROLE_GROUPS } from "@/lib/roles";
// Search result returned by feishu-user-search API (local DB, includes raw contact info)
type SearchResult = {
  userId: string;
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

function MemberCard({ member }: { member: MemberWithRoles }) {
  const photo = resolvePhoto(member.photoUrl) ?? member.avatarUrl;

  // v3 纯展示卡：小圆头像 + 名字 + 角色/标签徽章（无编辑入口）
  return (
    <div style={{
      background: "white", border: "1px solid var(--line)", borderRadius: 10,
      padding: "14px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
      textAlign: "center",
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: "50%", overflow: "hidden", flexShrink: 0,
        background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt={member.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontSize: 18, fontWeight: 500, color: "var(--muted)" }}>{member.name[0]}</span>
        )}
      </div>

      <div style={{ minWidth: 0, width: "100%" }}>
        <p style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {member.name}
          {member.status === "suspended" && (
            <span style={{ marginLeft: 4, borderRadius: 4, padding: "1px 4px", fontSize: 9, fontWeight: 600, background: "var(--danger-soft)", color: "var(--danger)", fontFamily: "system-ui, sans-serif", verticalAlign: 2 }}>停用</span>
          )}
        </p>
        {member.roles.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, justifyContent: "center", marginTop: 6 }}>
            {member.roles.map((r) => (
              <span key={r} style={{ borderRadius: 999, background: "var(--surface-2)", padding: "2px 7px", fontSize: 9, fontWeight: 700, color: "var(--muted)" }}>
                {r}
              </span>
            ))}
          </div>
        )}
        {member.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, justifyContent: "center", marginTop: 4 }}>
            {member.tags.map((t) => (
              <span key={t} style={{ borderRadius: 999, background: "var(--script-soft)", padding: "2px 7px", fontSize: 9, fontWeight: 700, color: "var(--script)" }}>
                {t}
              </span>
            ))}
          </div>
        )}
        {member.email && (
          <p style={{ margin: "6px 0 0", fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {member.email}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── EditInfoPanel ────────────────────────────────────────────────────────────

function EditInfoPanel({
  productionId,
  member,
  canManage,
  allMembers,
  onClose,
  onSaved,
  onDeleted,
}: {
  productionId: string;
  member: MemberWithRoles;
  canManage: boolean;
  allMembers: MemberWithRoles[];
  onClose: () => void;
  onSaved: (updated: Partial<MemberWithRoles>) => void;
  onDeleted: () => void;
}) {
  const [email, setEmail] = useState(member.email ?? "");
  const [phone, setPhone] = useState(member.phone ?? "");
  const [photoUrl, setPhotoUrl] = useState(member.photoUrl ?? "");
  const [selectedRoles, setSelectedRoles] = useState<string[]>(member.roles);
  // selectedTagIds tracks UUIDs (what the API expects); initialized once availableTags loads
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [supervisorId, setSupervisorId] = useState<string | null>(member.supervisorId);
  const [availableTags, setAvailableTags] = useState<{ id: string; name: string; isSystem: boolean }[]>([]);
  const [tagsReady, setTagsReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/member-tags`)
      .then((r) => r.json())
      .then((data: { tags?: { id: string; name: string; isSystem: boolean }[] }) => {
        const tags = data.tags ?? [];
        setAvailableTags(tags);
        // Convert member's current tag names → IDs
        const nameToId = new Map(tags.map((t) => [t.name, t.id]));
        setSelectedTagIds(member.tags.map((n) => nameToId.get(n)).filter(Boolean) as string[]);
        setTagsReady(true);
      })
      .catch(() => {});
  }, [productionId, member.tags]);

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const toggleTag = (id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { userId: member.userId };
      if (canManage) {
        body.roles = selectedRoles;
        body.tagIds = selectedTagIds;
        body.supervisorId = supervisorId;
      }
      body.email = email.trim() || null;
      body.phone = phone.trim() || null;
      body.photoUrl = photoUrl.trim() || null;

      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const resolvedSupervisorName = canManage
          ? (allMembers.find((m) => m.userId === supervisorId)?.name ?? null)
          : member.supervisorName;
        const resolvedTagNames = canManage
          ? availableTags.filter((t) => selectedTagIds.includes(t.id)).map((t) => t.name)
          : member.tags;
        onSaved({
          roles: canManage ? selectedRoles : member.roles,
          tags: resolvedTagNames,
          supervisorId: canManage ? supervisorId : member.supervisorId,
          supervisorName: resolvedSupervisorName,
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

  const otherMembers = allMembers.filter((m) => m.userId !== member.userId);

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

          {/* Tags — admin only */}
          {canManage && tagsReady && availableTags.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase">标签</p>
              <div className="flex flex-wrap gap-1.5">
                {availableTags.map((tag) => {
                  const active = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      onClick={() => toggleTag(tag.id)}
                      className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                        active
                          ? "bg-blue-600 text-white"
                          : "bg-blue-50 text-blue-500 hover:bg-blue-100"
                      }`}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Supervisor — admin only */}
          {canManage && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase">上级</p>
              <select
                value={supervisorId ?? ""}
                onChange={(e) => setSupervisorId(e.target.value || null)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 bg-white"
              >
                <option value="">— 无 —</option>
                {otherMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>{m.name}</option>
                ))}
              </select>
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

  const loadAllUsers = useCallback(async () => {
    setLoading(true);
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
  }, [productionId]);

  useEffect(() => { loadAllUsers(); }, [loadAllUsers]);

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
        name: selected.name,
        avatarUrl: selected.avatarUrl,
        isAdmin: false,
        email: selected.email ?? null,
        phone: selected.phone ?? null,
        roles: selectedRoles,
        tags: [],
        photoUrl: null,
        supervisorId: null,
        supervisorName: null,
        status: "active",
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

// ─── ContactsClient ───────────────────────────────────────────────────────────

type Props = {
  productionId: string;
  productionName: string;
  initialMembers: MemberWithRoles[];
  canImport: boolean;
  canManage: boolean;
  myUserId: string;
};

export default function ContactsClient({
  productionId,
  productionName,
  initialMembers,
  canImport,
  canManage,
  myUserId,
}: Props) {
  const [members, setMembers] = useState<MemberWithRoles[]>(initialMembers);
  const [editingUserId, setEditingOpenId] = useState<string | null>(null);
  const [showAddPanel, setShowAddPanel] = useState(false);

  const sorted = sortByFirstRole(members);
  const editingMember = editingUserId ? members.find((m) => m.userId === editingUserId) ?? null : null;
  const existingUserIds = new Set(members.map((m) => m.userId));

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
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Page header（v3 统一页头） */}
      {/* 纯展示页（v3）：人事编辑/导入/添加入口移除——人事操作归管理后台 */}
      <PageHeader eyebrow="People" title="人员" side="stage" />

      {/* Main card */}
      <div style={{ background: "var(--surface)", borderRadius: 13, border: "1px solid var(--line)", padding: 22, minHeight: "calc(100vh - 280px)" }}>
        {sorted.length === 0 ? (
          <div style={{ padding: "48px 0", textAlign: "center" }}>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>暂无人员</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8">
            {sorted.map((m) => (
              <MemberCard key={m.userId} member={m} />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
