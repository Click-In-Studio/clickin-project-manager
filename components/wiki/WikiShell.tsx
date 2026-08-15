"use client";

// wiki 文档库 W4：文档树侧栏骨架（两页共用：库首页 / 文档页）。
// 树逻辑沿 TreePickerModal 的邻接表→DFS 展开 + 搜索保留祖先链，另加展开/折叠态。

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import { PRIMARY_BTN } from "@/components/PageHeader";
import type { WikiListEntry } from "@/lib/wiki-db";

type Node = { entry: WikiListEntry; depth: number; hasChildren: boolean };

export default function WikiShell({
  productionId,
  wikis,
  canCreate,
  selectedId,
  children,
}: {
  productionId: string;
  wikis: WikiListEntry[];
  canCreate: boolean;
  selectedId?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const { flat, ancestorsOfSelected } = useMemo(() => {
    const ids = new Set(wikis.map(w => w.id));
    const byParent = new Map<string | null, WikiListEntry[]>();
    const byId = new Map(wikis.map(w => [w.id, w]));
    for (const w of wikis) {
      const key = w.parentId && ids.has(w.parentId) ? w.parentId : null;
      byParent.set(key, [...(byParent.get(key) ?? []), w]);
    }
    // 搜索：命中项 + 祖先链保留
    let visible: Set<string> | null = null;
    const q = query.trim().toLowerCase();
    if (q) {
      visible = new Set();
      for (const w of wikis) {
        const hit = (w.title ?? "").toLowerCase().includes(q)
          || w.tags.some(t => t.toLowerCase().includes(q));
        if (!hit) continue;
        let cur: WikiListEntry | undefined = w;
        while (cur && !visible.has(cur.id)) {
          visible.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
    }
    const flat: Node[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const w of byParent.get(parent) ?? []) {
        if (visible && !visible.has(w.id)) continue;
        const hasChildren = (byParent.get(w.id) ?? []).length > 0;
        flat.push({ entry: w, depth, hasChildren });
        if (!collapsed.has(w.id) || q) walk(w.id, depth + 1);
      }
    };
    walk(null, 0);
    // 选中项的祖先链（用于高亮路径；折叠态由用户手动控制）
    const anc = new Set<string>();
    let cur = selectedId ? byId.get(selectedId) : undefined;
    while (cur?.parentId) { anc.add(cur.parentId); cur = byId.get(cur.parentId); }
    return { flat, ancestorsOfSelected: anc };
  }, [wikis, query, collapsed, selectedId]);

  async function create() {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "创建失败"); return; }
      setCreating(false);
      setNewTitle("");
      router.push(`/production/${productionId}/wiki/${data.wiki.id}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-6 items-start">
      <aside className="w-[260px] shrink-0 rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="p-3 border-b border-zinc-100 space-y-2">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索文档 / 标签…"
            className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-400"
          />
          {canCreate && (creating ? (
            <div className="flex gap-1.5">
              <input
                autoFocus
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") create(); if (e.key === "Escape") setCreating(false); }}
                placeholder="文档标题，回车创建"
                className="flex-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-500"
              />
              <button type="button" onClick={create} disabled={busy} style={{ ...PRIMARY_BTN, padding: "6px 10px" }}>
                建
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full rounded-lg border border-dashed border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 text-left"
            >
              ＋ 新建文档
            </button>
          ))}
        </div>
        <nav className="py-1.5 max-h-[70vh] overflow-y-auto">
          {flat.length === 0 && (
            <p className="px-3 py-3 text-sm text-zinc-400">{query ? "无匹配文档" : "还没有可见的文档"}</p>
          )}
          {flat.map(({ entry, depth, hasChildren }) => {
            const active = entry.id === selectedId;
            const onPath = ancestorsOfSelected.has(entry.id);
            return (
              <div
                key={entry.id}
                className={`flex items-center gap-1 pr-2 ${active ? "bg-sky-50" : "hover:bg-zinc-50"}`}
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                <button
                  type="button"
                  onClick={() => setCollapsed(prev => {
                    const next = new Set(prev);
                    if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                    return next;
                  })}
                  className={`w-4 text-[10px] text-zinc-400 ${hasChildren ? "" : "invisible"}`}
                  aria-label="展开/折叠"
                >
                  {collapsed.has(entry.id) ? "▸" : "▾"}
                </button>
                <Link
                  href={`/production/${productionId}/wiki/${entry.id}`}
                  className={`flex-1 truncate py-1.5 text-sm ${
                    active ? "font-semibold text-sky-800" : onPath ? "text-zinc-700 font-medium" : "text-zinc-600"
                  }`}
                >
                  {entry.title ?? "（无标题）"}
                </Link>
                {entry.isPublic && <span className="text-[10px] text-zinc-300" title="已公开给全体成员">◍</span>}
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
