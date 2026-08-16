"use client";

// wiki 文档库 W4（Notion 式改版）：文档树侧栏承载全部文档操作——
// 新建（根/子文档，行悬停 ＋）、移动、删除（行悬停 ⋯ 菜单）、树导航。
// 树逻辑：邻接表→DFS 展开 + 搜索保留祖先链 + 展开/折叠态。

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import { keyBetween } from "@/lib/lex-order";
import TreePickerModal from "@/components/TreePickerModal";
import type { WikiListEntry } from "@/lib/wiki-db";

type DropZone = "before" | "after" | "inside";

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
  // 新建：creatingUnder = null 未在建 / "" 根级 / <id> 子文档
  const [creatingUnder, setCreatingUnder] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  // ⋯ 菜单经 portal 固定定位（nav 有 overflow-y-auto，绝对定位会被裁剪）
  const [menu, setMenu] = useState<{ id: string; top: number; left: number } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) setMenu(null);
    };
    const closeOnScroll = () => setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [menu]);

  const byId = useMemo(() => new Map(wikis.map(w => [w.id, w])), [wikis]);

  // 同层有序邻接表（wikis 已按服务端 sort_key NULLS LAST, created_at 排序，分组后保持相对序）
  const byParent = useMemo(() => {
    const ids = new Set(wikis.map(w => w.id));
    const m = new Map<string | null, WikiListEntry[]>();
    for (const w of wikis) {
      const key = w.parentId && ids.has(w.parentId) ? w.parentId : null;
      m.set(key, [...(m.get(key) ?? []), w]);
    }
    return m;
  }, [wikis]);

  // ── 拖拽调层级（Notion 式：行上/下缘=同级排序，行中部=成为子文档）──────────
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; zone: DropZone } | null>(null);

  const dragDescendants = useMemo(() => {
    if (!dragId) return new Set<string>();
    const set = new Set([dragId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const w of wikis) {
        if (w.parentId && set.has(w.parentId) && !set.has(w.id)) { set.add(w.id); grew = true; }
      }
    }
    return set;
  }, [dragId, wikis]);

  async function performDrop(targetId: string, zone: DropZone) {
    const id = dragId;
    setDragId(null);
    setDropHint(null);
    if (!id || id === targetId || dragDescendants.has(targetId)) return;
    const target = byId.get(targetId);
    if (!target) return;

    let parentId: string | null;
    let sortKey: string;
    if (zone === "inside") {
      parentId = targetId;
      const children = (byParent.get(targetId) ?? []).filter(w => w.id !== id);
      sortKey = keyBetween(children.at(-1)?.sortKey ?? null, null);
    } else {
      parentId = target.parentId ?? null;
      const siblings = (byParent.get(parentId) ?? []).filter(w => w.id !== id);
      const idx = siblings.findIndex(w => w.id === targetId);
      const prev = zone === "before" ? siblings[idx - 1] : siblings[idx];
      const next = zone === "before" ? siblings[idx] : siblings[idx + 1];
      sortKey = keyBetween(prev?.sortKey ?? null, next?.sortKey ?? null);
    }

    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId, sortKey }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "移动失败"); return; }
    if (zone === "inside") setCollapsed(prev => { const n = new Set(prev); n.delete(targetId); return n; });
    router.refresh();
  }

  const flat = useMemo(() => {
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
    const out: Node[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const w of byParent.get(parent) ?? []) {
        if (visible && !visible.has(w.id)) continue;
        const hasChildren = (byParent.get(w.id) ?? []).length > 0;
        out.push({ entry: w, depth, hasChildren });
        if (!collapsed.has(w.id) || q) walk(w.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [wikis, query, collapsed, byId, byParent]);

  async function create(parentId: string | null) {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, parentId: parentId || null }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "创建失败"); return; }
      setCreatingUnder(null);
      setNewTitle("");
      if (parentId) setCollapsed(prev => { const n = new Set(prev); n.delete(parentId); return n; });
      router.push(`/production/${productionId}/wiki/${data.wiki.id}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const doc = byId.get(id);
    if (!confirm(`确认删除「${doc?.title ?? "该文档"}」？子文档将提升为顶层。`)) return;
    setMenu(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${id}`, { method: "DELETE" });
    if (!res.ok) { alert((await res.json()).error ?? "删除失败"); return; }
    if (id === selectedId) router.push(`/production/${productionId}/wiki`);
    router.refresh();
  }

  async function move(id: string, targetIds: string[]) {
    setMovingId(null);
    const target = targetIds[0];
    if (target === undefined) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: target === "__root__" ? null : target }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "移动失败"); return; }
    router.refresh();
  }

  // 移动候选：排除自身与后代（防环；服务端另有校验）
  function moveItemsFor(id: string) {
    const descendants = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const w of wikis) {
        if (w.parentId && descendants.has(w.parentId) && !descendants.has(w.id)) {
          descendants.add(w.id); grew = true;
        }
      }
    }
    return [
      { id: "__root__", label: "（移到顶层）" },
      ...wikis.filter(w => !descendants.has(w.id)).map(w => ({
        id: w.id, label: w.title ?? "（无标题）", parentId: w.parentId,
      })),
    ];
  }

  const newDocInput = (parentId: string, depth: number) => (
    <div className="flex gap-1 py-1 pr-2" style={{ paddingLeft: 8 + depth * 14 + 18 }}>
      <input
        autoFocus
        value={newTitle}
        onChange={e => setNewTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") create(parentId || null);
          if (e.key === "Escape") { setCreatingUnder(null); setNewTitle(""); }
        }}
        onBlur={() => { if (!newTitle.trim()) { setCreatingUnder(null); setNewTitle(""); } }}
        placeholder="标题，回车创建"
        className="flex-1 min-w-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[13px] outline-none focus:border-zinc-500"
      />
    </div>
  );

  return (
    <div className="flex gap-6 items-stretch min-h-[calc(100vh-210px)]">
      <aside className="w-[264px] shrink-0 flex flex-col rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="p-2.5 border-b border-zinc-100">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索文档 / 标签…"
            className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-400"
          />
        </div>
        <nav className="py-1 flex-1 overflow-y-auto">
          {flat.length === 0 && !creatingUnder && (
            <p className="px-3 py-3 text-sm text-zinc-400">{query ? "无匹配文档" : "还没有可见的文档"}</p>
          )}
          {flat.map(({ entry, depth, hasChildren }) => {
            const active = entry.id === selectedId;
            const hint = dropHint?.id === entry.id ? dropHint.zone : null;
            const droppable = dragId && dragId !== entry.id && !dragDescendants.has(entry.id);
            return (
              <div key={entry.id}>
                <div
                  draggable
                  onDragStart={e => { setDragId(entry.id); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDragId(null); setDropHint(null); }}
                  onDragOver={e => {
                    if (!droppable) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const r = e.currentTarget.getBoundingClientRect();
                    const y = (e.clientY - r.top) / r.height;
                    const zone: DropZone = y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
                    setDropHint(prev => prev?.id === entry.id && prev.zone === zone ? prev : { id: entry.id, zone });
                  }}
                  onDragLeave={() => setDropHint(prev => (prev?.id === entry.id ? null : prev))}
                  onDrop={e => { e.preventDefault(); if (droppable && hint) performDrop(entry.id, hint); }}
                  className={`group flex items-center gap-0.5 pr-1.5 rounded-md mx-1 ${
                    hint === "inside" ? "bg-sky-100 ring-1 ring-sky-300"
                    : active ? "bg-sky-50" : "hover:bg-zinc-50"
                  } ${dragId === entry.id ? "opacity-40" : ""}`}
                  style={{
                    paddingLeft: 4 + depth * 14,
                    boxShadow: hint === "before" ? "inset 0 2px 0 0 #38bdf8"
                      : hint === "after" ? "inset 0 -2px 0 0 #38bdf8" : undefined,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setCollapsed(prev => {
                      const next = new Set(prev);
                      if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                      return next;
                    })}
                    className={`w-4 shrink-0 text-[10px] text-zinc-400 hover:text-zinc-600 ${hasChildren ? "" : "invisible"}`}
                    aria-label="展开/折叠"
                  >
                    {collapsed.has(entry.id) ? "▸" : "▾"}
                  </button>
                  <Link
                    href={`/production/${productionId}/wiki/${entry.id}`}
                    className={`flex-1 min-w-0 truncate py-1.5 text-[13px] ${
                      active ? "font-semibold text-sky-800" : "text-zinc-600"
                    }`}
                    title={entry.title ?? undefined}
                  >
                    {entry.title ?? "（无标题）"}
                  </Link>
                  {entry.isPublic && (
                    <span className="shrink-0 text-[10px] text-zinc-300 group-hover:hidden" title="已公开给全体成员">◍</span>
                  )}
                  {/* 悬停操作区：＋ 新建子文档 / ⋯ 菜单 */}
                  <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                    {canCreate && (
                      <button
                        type="button"
                        title="新建子文档"
                        onClick={() => { setCreatingUnder(entry.id); setNewTitle(""); setMenu(null); }}
                        className="w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/60 text-sm leading-none"
                      >
                        ＋
                      </button>
                    )}
                    <button
                      type="button"
                      title="更多操作"
                      onClick={e => {
                        if (menu?.id === entry.id) { setMenu(null); return; }
                        const r = e.currentTarget.getBoundingClientRect();
                        setMenu({ id: entry.id, top: r.bottom + 2, left: Math.max(8, r.right - 128) });
                      }}
                      className="w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/60 text-sm leading-none"
                    >
                      ⋯
                    </button>
                  </div>
                </div>
                {creatingUnder === entry.id && newDocInput(entry.id, depth + 1)}
              </div>
            );
          })}
          {creatingUnder === "" && newDocInput("", 0)}
        </nav>
        {canCreate && (
          <button
            type="button"
            onClick={() => { setCreatingUnder(""); setNewTitle(""); }}
            className="w-full border-t border-zinc-100 px-3 py-2 text-left text-[13px] text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50"
          >
            ＋ 新建文档
          </button>
        )}
      </aside>
      <main className="flex-1 min-w-0 flex flex-col [&>*]:flex-1">{children}</main>

      {menu && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: menu.top, left: menu.left, zIndex: 9999 }}
          className="w-32 rounded-lg border border-zinc-200 bg-white shadow-lg py-1"
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
            onClick={() => { const id = menu.id; setMenu(null); setMovingId(id); }}
          >
            移动到…
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
            onClick={() => remove(menu.id)}
          >
            删除
          </button>
        </div>,
        document.body,
      )}

      {movingId && (
        <TreePickerModal
          kicker="Wiki"
          title={`移动「${byId.get(movingId)?.title ?? ""}」到…`}
          items={moveItemsFor(movingId)}
          preselected={[]}
          single
          onConfirm={ids => move(movingId, ids)}
          onClose={() => setMovingId(null)}
        />
      )}
    </div>
  );
}
