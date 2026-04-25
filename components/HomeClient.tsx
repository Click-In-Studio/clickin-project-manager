"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

type Production = { id: string; name: string; createdAt: string };

type Props = {
  productions: Production[];
  isAdmin: boolean;
  currentUser: { name: string; avatarUrl: string | null };
};

export default function HomeClient({ productions: initial, isAdmin, currentUser }: Props) {
  const router = useRouter();
  const [productions, setProductions] = useState<Production[]>(initial);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [error, setError] = useState("");
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
      router.push(`/production/${data.id}`);
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
      if (res.ok) setProductions((prev) => prev.filter((p) => p.id !== id));
    } catch { /* ignore */ } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-100 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white px-8 py-8 shadow-sm">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase">项目管理器</h1>
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
            {productions.map((p) => (
              <li key={p.id} className="group flex items-center gap-1 rounded-lg hover:bg-zinc-50">
                <button
                  onClick={() => router.push(`/production/${p.id}`)}
                  className="flex-1 px-3 py-2.5 text-left text-sm text-zinc-700"
                >
                  {p.name}
                </button>
                {isAdmin && (
                  <button
                    onClick={() => deleteProduction(p.id)}
                    disabled={deleting === p.id}
                    title="删除剧本"
                    className="shrink-0 rounded px-1.5 py-1 text-[11px] text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-400 disabled:opacity-30 transition-opacity"
                  >
                    删除
                  </button>
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
                onChange={(e) => { setNewName(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && create()}
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
