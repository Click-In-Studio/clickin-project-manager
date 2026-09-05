"use client";

// 挂载点四动作的文档侧两面板（#420 第二批 PR-B）：
//   WikiSelectPanel —— 从树里挑现有文档挂到宿主上。候选=枚举面（能在树里列到
//     什么就能挑什么，与树页同源）；挂载门在服务端（canShareWiki ∧ 宿主侧）。
//   WikiCreatePanel —— 就地新建文档并挂载。落点走缺省落点解析（lib/node/
//     landing.ts：event 系归事件目录链，其余暂落顶层待拍板）。建档与挂边是
//     两次调用，挂边失败留下的是一篇只有创建者可见的文档，无越权面。
import { useState, useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { NodeEntry } from "@/lib/node/db";
import type { MountContext } from "@/components/assets/AssetSelectPanel";

async function mountNode(
  productionId: string, nodeId: string, mountCtx: MountContext,
): Promise<string | null> {
  const res = await fetch(`${BASE_PATH}/api/production/${productionId}/node/${nodeId}/mounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mountType: mountCtx.mountType,
      mountId: mountCtx.mountId,
      mountAuxId: mountCtx.mountAuxId ?? null,
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    return (j as { error?: string }).error ?? `挂载失败 (${res.status})`;
  }
  return null;
}

export function WikiSelectPanel({ productionId, mountCtx, onMounted, onCancel }: {
  productionId: string;
  mountCtx: MountContext;
  onMounted: (wikiId: string, label: string) => void;
  onCancel?: () => void;
}) {
  const [docs, setDocs] = useState<NodeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<NodeEntry | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/wiki`)
      .then(r => r.json())
      .then((j: { nodes?: NodeEntry[] }) =>
        setDocs((j.nodes ?? []).filter(n => n.kind === "wiki" && n.wikiId)))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [productionId]);

  const filtered = docs.filter(d => {
    const q = search.toLowerCase();
    return !q || (d.displayTitle ?? "").toLowerCase().includes(q);
  });

  async function handleMount() {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    const err = await mountNode(productionId, selected.id, mountCtx);
    setSubmitting(false);
    if (err) { setError(err); return; }
    onMounted(selected.wikiId!, selected.displayTitle ?? "无标题");
  }

  return (
    <div>
      <input
        type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="搜索文档标题…"
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-zinc-300"
      />
      {loading ? (
        <p className="text-xs text-zinc-400 py-4 text-center">加载中…</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-zinc-400 py-4 text-center">没有可挑选的文档</p>
      ) : (
        <div className="max-h-60 overflow-y-auto space-y-0.5 mb-3">
          {filtered.map(d => (
            <button key={d.id} onClick={() => setSelected(d)}
              className={`block w-full rounded-lg px-2.5 py-1.5 text-left text-xs truncate transition-colors ${
                selected?.id === d.id ? "bg-zinc-800 text-white" : "text-zinc-700 hover:bg-zinc-100"
              }`}>
              {d.displayTitle ?? "无标题"}
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100">取消</button>
        )}
        <button onClick={handleMount} disabled={!selected || submitting}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 hover:bg-zinc-700">
          {submitting ? "挂载中…" : "挂载"}
        </button>
      </div>
    </div>
  );
}

export function WikiCreatePanel({ productionId, mountCtx, onMounted, onCancel }: {
  productionId: string;
  mountCtx: MountContext;
  onMounted: (wikiId: string, label: string) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    const t = title.trim();
    if (!t) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t,
          landing: { kind: "mount", mountType: mountCtx.mountType, mountId: mountCtx.mountId },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((j as { error?: string }).error ?? `创建失败 (${res.status})`);
        return;
      }
      const wiki = (j as { wiki: { id: string; nodeId: string } }).wiki;
      const err = await mountNode(productionId, wiki.nodeId, mountCtx);
      if (err) { setError(`文档已创建但挂载失败：${err}`); return; }
      onMounted(wiki.id, t);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <input
        type="text" value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") handleCreate(); }}
        placeholder="新文档标题…" autoFocus
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-zinc-300"
      />
      <p className="text-[10px] text-zinc-400 mb-3">文档将挂载到此处；事件类上下文自动归档进事件目录，其余暂落知识库顶层</p>
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100">取消</button>
        )}
        <button onClick={handleCreate} disabled={!title.trim() || submitting}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 hover:bg-zinc-700">
          {submitting ? "创建中…" : "创建并挂载"}
        </button>
      </div>
    </div>
  );
}
