"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

type Production = { id: string; name: string; createdAt: string };
type UserInfo = { openId: string; name: string; avatarUrl: string | null; isAdmin: boolean };

type Props = {
  productions: Production[];
  isAdmin: boolean;
  currentUser: { name: string; avatarUrl: string | null };
  allUsers: UserInfo[];
};

// ─── MembersPanel ─────────────────────────────────────────────────────────────

function MembersPanel({
  production,
  allUsers,
  onClose,
}: {
  production: Production;
  allUsers: UserInfo[];
  onClose: () => void;
}) {
  const [members, setMembers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [addQuery, setAddQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/script/${production.id}/members`)
      .then(r => r.json())
      .then(d => setMembers(d.members ?? []))
      .finally(() => setLoading(false));
  }, [production.id]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const memberIds = new Set(members.map(m => m.openId));
  const addCandidates = allUsers.filter(
    u => !memberIds.has(u.openId) && u.name.includes(addQuery)
  );

  const addMember = async (openId: string) => {
    await fetch(`${BASE_PATH}/api/script/${production.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openId }),
    });
    const user = allUsers.find(u => u.openId === openId);
    if (user) setMembers(prev => [...prev, user]);
    setAddQuery("");
  };

  const removeMember = async (openId: string) => {
    await fetch(`${BASE_PATH}/api/script/${production.id}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openId }),
    });
    setMembers(prev => prev.filter(m => m.openId !== openId));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <div ref={panelRef} className="w-80 rounded-2xl bg-white shadow-xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
          <div>
            <p className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">成员管理</p>
            <p className="text-sm font-medium text-zinc-700 mt-0.5">{production.name}</p>
          </div>
          <button onClick={onClose} className="text-zinc-300 hover:text-zinc-500 text-lg leading-none">×</button>
        </div>

        <div className="px-5 py-3">
          {loading ? (
            <p className="text-xs text-zinc-300 py-2">加载中…</p>
          ) : members.length === 0 ? (
            <p className="text-xs text-zinc-300 py-2 text-center">暂无参与者</p>
          ) : (
            <ul className="space-y-1 mb-3">
              {members.map(m => (
                <li key={m.openId} className="group flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-zinc-50">
                  <span className="text-sm text-zinc-700">{m.name}</span>
                  <button
                    onClick={() => removeMember(m.openId)}
                    className="text-xs text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add member */}
          <div className="relative border-t border-zinc-100 pt-3">
            <input
              value={addQuery}
              onChange={e => setAddQuery(e.target.value)}
              placeholder="搜索用户添加…"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none placeholder:text-zinc-300 focus:border-zinc-400"
            />
            {addQuery && addCandidates.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 rounded-xl border border-zinc-100 bg-white py-1 shadow-xl z-10">
                {addCandidates.slice(0, 8).map(u => (
                  <button
                    key={u.openId}
                    onMouseDown={e => { e.preventDefault(); addMember(u.openId); }}
                    className="w-full px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-50"
                  >
                    {u.name}
                  </button>
                ))}
              </div>
            )}
            {addQuery && addCandidates.length === 0 && (
              <p className="mt-1 text-xs text-zinc-300">无匹配用户（用户需先登录才会出现）</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── HomeClient ───────────────────────────────────────────────────────────────

export default function HomeClient({ productions: initial, isAdmin, currentUser, allUsers }: Props) {
  const router = useRouter();
  const [productions, setProductions] = useState<Production[]>(initial);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [error, setError] = useState("");
  const [membersFor, setMembersFor] = useState<Production | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "创建失败"); return; }
      router.push(`/script/${data.id}`);
    } catch {
      setError("网络错误，请重试");
    } finally {
      setCreating(false);
    }
  };

  const deleteProduction = async (id: string) => {
    if (!confirm("确定要删除这个剧本吗？此操作不可撤销。")) return;
    setDeleting(id);
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) setProductions(prev => prev.filter(p => p.id !== id));
    } catch { /* ignore */ } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-100 px-4">
      {membersFor && (
        <MembersPanel
          production={membersFor}
          allUsers={allUsers}
          onClose={() => setMembersFor(null)}
        />
      )}

      <div className="w-full max-w-sm rounded-2xl bg-white px-8 py-8 shadow-sm">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase">剧本编辑器</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400">{currentUser.name}</span>
            <form action={`${BASE_PATH}/api/auth/logout`} method="post">
              <button type="submit" className="text-xs text-zinc-300 hover:text-zinc-500 transition-colors">
                退出
              </button>
            </form>
          </div>
        </div>

        {/* Productions list */}
        {productions.length === 0 && !showInput ? (
          <p className="mb-4 text-center text-xs text-zinc-300">暂无剧本</p>
        ) : (
          <ul className="mb-3 space-y-1">
            {productions.map(p => (
              <li key={p.id} className="group flex items-center gap-1 rounded-lg hover:bg-zinc-50">
                <button
                  onClick={() => router.push(`/script/${p.id}`)}
                  className="flex-1 px-3 py-2.5 text-left text-sm text-zinc-700"
                >
                  {p.name}
                </button>
                {isAdmin && (
                  <>
                    <button
                      onClick={() => setMembersFor(p)}
                      title="管理成员"
                      className="shrink-0 rounded px-1.5 py-1 text-[11px] text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-zinc-600 transition-opacity"
                    >
                      成员
                    </button>
                    <button
                      onClick={() => deleteProduction(p.id)}
                      disabled={deleting === p.id}
                      title="删除剧本"
                      className="shrink-0 rounded px-1.5 py-1 text-[11px] text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-400 disabled:opacity-30 transition-opacity"
                    >
                      删除
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Create new production (admin only) */}
        {isAdmin && (
          showInput ? (
            <>
              <input
                value={newName}
                onChange={e => { setNewName(e.target.value); setError(""); }}
                onKeyDown={e => e.key === "Enter" && create()}
                placeholder="输入剧名"
                autoFocus
                className="w-full rounded-lg border border-zinc-200 px-4 py-2.5 text-sm text-zinc-800 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
              />
              {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => { setShowInput(false); setNewName(""); setError(""); }}
                  className="flex-1 rounded-lg border border-zinc-200 py-2.5 text-sm text-zinc-500 hover:border-zinc-400"
                >
                  取消
                </button>
                <button
                  onClick={create}
                  disabled={!newName.trim() || creating}
                  className="flex-1 rounded-lg bg-zinc-800 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-30"
                >
                  {creating ? "创建中…" : "创建"}
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={() => setShowInput(true)}
              className="w-full rounded-lg border border-zinc-200 py-2.5 text-sm font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 transition-colors"
            >
              新建剧本
            </button>
          )
        )}
      </div>
    </div>
  );
}
