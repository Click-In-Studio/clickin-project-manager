"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import AdminModal from "@/components/ui/AdminModal";
import DropdownPicker from "@/components/ui/DropdownPicker";

type ShareState = {
  isPublic: boolean; listable: boolean; deptIds: string[];
  people: { userId: string; canDownload: boolean; removable: boolean }[];
};

export default function AssetAccessModal({ productionId, assetId, assetName, members, departments, onClose }: {
  productionId: string; assetId: string; assetName: string;
  members: { userId: string; name: string }[];
  departments: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [share, setShare] = useState<ShareState | null>(null);
  const [addUser, setAddUser] = useState("");
  const [allowDownload, setAllowDownload] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const api = `${BASE_PATH}/api/production/${productionId}/assets/${assetId}/access`;
  const load = useCallback(async () => {
    const res = await fetch(api);
    if (res.ok) setShare(await res.json() as ShareState);
    else setError((await res.json().catch(() => ({})) as { error?: string }).error ?? "分享设置加载失败");
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  async function update(patch: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(api, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})) as { error?: string }).error ?? "保存失败");
        return false;
      }
      await load();
      router.refresh();
      return true;
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminModal title={`站内分享「${assetName}」`} onClose={onClose}>
      {!share ? <p className="text-sm text-zinc-500">加载中…</p> : (
        <div className="space-y-4 text-sm text-zinc-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={share.isPublic} disabled={saving}
              onChange={e => void update({ isPublic: e.target.checked })} />
            <span>公开给全体成员阅读</span>
          </label>
          <div className="rounded-lg border border-zinc-200 px-3 py-2.5">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={share.listable} disabled={saving}
                onChange={e => void update({ listable: e.target.checked })} />
              <span>在目录树中列出</span>
            </label>
            <p className="mt-1 text-xs text-zinc-400">列出只显示标题；阅读由公开、个人、部门和挂载决定。</p>
          </div>
          <div>
            <p className="font-medium mb-1.5">分享给部门</p>
            <DropdownPicker multi items={departments.map(d => ({ id: d.id, label: d.name }))}
              values={new Set(share.deptIds)} placeholder="选择部门…" searchPlaceholder="搜索部门"
              multiCountLabel={n => n ? `已分享 ${n} 个部门` : "选择部门…"}
              onChange={() => {}}
              onToggle={deptId => {
                const deptIds = share.deptIds.includes(deptId)
                  ? share.deptIds.filter(id => id !== deptId) : [...share.deptIds, deptId];
                void update({ deptIds });
              }} />
          </div>
          <div>
            <p className="font-medium mb-1.5">分享给个人</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <DropdownPicker items={members.filter(m => !share.people.some(p => p.userId === m.userId))
                  .map(m => ({ id: m.userId, label: m.name }))}
                  value={addUser || null} placeholder="选择成员…" searchPlaceholder="搜索成员"
                  onChange={id => setAddUser(id ?? "")} />
              </div>
              <button type="button" className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-white disabled:opacity-50"
                disabled={!addUser || saving}
                onClick={async () => {
                  if (await update({ addPerson: { userId: addUser, canDownload: allowDownload } })) setAddUser("");
                }}>添加</button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={allowDownload} onChange={e => setAllowDownload(e.target.checked)} />
              同时允许下载原件
            </label>
            <ul className="mt-3 space-y-1">
              {share.people.map(p => (
                <li key={p.userId} className="flex items-center justify-between rounded-lg bg-zinc-50 px-2.5 py-1.5">
                  <span>{members.find(m => m.userId === p.userId)?.name ?? "项目成员"}
                    <span className="text-xs text-zinc-400"> · {p.canDownload ? "可下载" : "可阅读"}</span></span>
                  <button type="button" disabled={saving || !p.removable}
                    title={p.removable ? "移除个人分享" : "此人的访问来自已有授权，不能在这里移除"}
                    className="text-xs text-red-600 disabled:opacity-50"
                    onClick={() => void update({ removePersonUserId: p.userId })}>移除</button>
                </li>
              ))}
              {share.people.length === 0 && <li className="text-xs text-zinc-400">尚未单独分享给任何人</li>}
            </ul>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
    </AdminModal>
  );
}
