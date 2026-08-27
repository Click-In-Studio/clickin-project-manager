"use client";

// wiki 文档库 W4（Notion 式改版）：文档树侧栏承载全部文档操作——
// 新建（根/子文档，行悬停 ＋）、移动、删除（行悬停 ⋯ 菜单）、树导航。
// 树逻辑：邻接表→DFS 展开 + 搜索保留祖先链 + 展开/折叠态。

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import TreePickerModal from "@/components/TreePickerModal";
import type { WikiListEntry } from "@/lib/wiki-db";

type DropZone = "before" | "after" | "inside";

type Node = { entry: WikiListEntry; depth: number; hasChildren: boolean };

export default function WikiShell({
  productionId,
  wikis,
  canCreate,
  selectedId,
  navigationBasePath,
  rootParentId,
  rootAnchor,
  children,
}: {
  productionId: string;
  wikis: WikiListEntry[];
  canCreate: boolean;
  selectedId?: string;
  /** Optional route namespace for a scoped wiki workspace. API paths stay unchanged. */
  navigationBasePath?: string;
  /** Parent used when this shell presents a subtree as its visual root. */
  rootParentId?: string;
  /** 根锚点尚未懒建时的落位声明——服务端过完 create 门后解析成真正的 parentId。 */
  rootAnchor?: "dramaturgy";
  children: React.ReactNode;
}) {
  const router = useRouter();
  const routeBase = navigationBasePath ?? `/production/${productionId}/wiki`;
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map(wikis.map(w => [w.id, w])), [wikis]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  // 默认全收起；展开状态按 production 持久化 localStorage
  const storageKey = `clickin-wiki-tree-expanded:${productionId}`;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const hydratedRef = useRef(false);

  // 挂载后读回持久化状态（避免 SSR 水合不一致），并展开选中文档的祖先链
  useEffect(() => {
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as string[]; } catch { /* 忽略坏数据 */ }
    setExpanded(prev => {
      const next = new Set([...prev, ...saved]);
      let cur = selectedId ? byIdRef.current.get(selectedId) : undefined;
      while (cur?.parentId) { next.add(cur.parentId); cur = byIdRef.current.get(cur.parentId); }
      return next;
    });
    hydratedRef.current = true;
  }, [storageKey, selectedId]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    try { localStorage.setItem(storageKey, JSON.stringify([...expanded])); } catch { /* 配额满等，忽略 */ }
  }, [expanded, storageKey]);
  // 新建：creatingUnder = null 未在建 / "" 根级 / <id> 子文档
  const [creatingUnder, setCreatingUnder] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  // 可枚举性（#357）：默认进目录；取消勾选＝只有被显式分享的人能在树里列到它，
  // 且它的整棵子树随之对他人隐藏（E(子) ⊆ E(父)）。建完可在分享面板改。
  const [newListable, setNewListable] = useState(true);
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

    // 排序键一律由服务端在**完整**兄弟集上算（#357 症状②）：可枚举性逐节点后
    // 客户端手里的兄弟集可能有空洞，在残缺集上取键会和看不见的兄弟交错。
    // 这里只声明「挂到谁下面 / 放在谁的前后」，不自己算键。
    const parentId = zone === "inside"
      ? targetId
      : rootParentId && target.parentId === rootParentId ? null : target.parentId ?? null;
    const place = zone === "inside" ? undefined : { anchorId: targetId, side: zone };

    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentId: parentId ?? rootParentId ?? null,
        ...(place ? { place } : {}),
      }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "移动失败"); return; }
    if (zone === "inside") setExpanded(prev => new Set([...prev, targetId]));
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
        if (expanded.has(w.id) || q) walk(w.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [wikis, query, expanded, byId, byParent]);

  async function create(parentId: string | null) {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          parentId: parentId || rootParentId || null,
          listable: newListable,
          ...(parentId ? {} : { parentAnchor: rootAnchor }),
        }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "创建失败"); return; }
      setCreatingUnder(null);
      setNewTitle("");
      setNewListable(true);
      if (parentId) setExpanded(prev => new Set([...prev, parentId]));
      router.push(`${routeBase}/${data.wiki.id}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // 导入 markdown（暴力导入：正文原样入库，不做链接解析/替换）；标题=文件名去后缀
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  async function importFiles(files: FileList | null) {
    if (!files || files.length === 0 || importing) return;
    setImporting(true);
    try {
      let firstId: string | null = null;
      const errors: string[] = [];
      for (const file of Array.from(files)) {
        try {
          const text = await file.text();
          const title = file.name.replace(/\.(md|markdown|txt)$/i, "").trim() || "导入文档";
          const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title, body: text, parentId: rootParentId || null, parentAnchor: rootAnchor,
            }),
          });
          const data = await res.json();
          if (!res.ok) { errors.push(`${file.name}: ${data.error ?? "失败"}`); continue; }
          firstId ??= data.wiki.id as string;
        } catch {
          errors.push(`${file.name}: 读取失败`);
        }
      }
      if (errors.length > 0) alert(`部分导入失败：\n${errors.join("\n")}`);
      if (firstId) router.push(`${routeBase}/${firstId}`);
      router.refresh();
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  async function remove(id: string) {
    const doc = byId.get(id);
    if (!confirm(`确认删除「${doc?.title ?? "该文档"}」？子文档将上移一层。`)) return;
    setMenu(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${id}`, { method: "DELETE" });
    if (!res.ok) { alert((await res.json()).error ?? "删除失败"); return; }
    if (id === selectedId) router.push(routeBase);
    router.refresh();
  }

  async function move(id: string, targetIds: string[]) {
    setMovingId(null);
    const target = targetIds[0];
    if (target === undefined) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: target === "__root__" ? rootParentId ?? null : target }),
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
    <div className="py-1 pr-2" style={{ paddingLeft: 8 + depth * 14 + 18 }}>
      <div className="flex gap-1">
      <input
        autoFocus
        value={newTitle}
        onChange={e => setNewTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") create(parentId || null);
          if (e.key === "Escape") { setCreatingUnder(null); setNewTitle(""); setNewListable(true); }
        }}
        onBlur={() => { if (!newTitle.trim()) { setCreatingUnder(null); setNewTitle(""); setNewListable(true); } }}
        placeholder="标题，回车创建"
        className="flex-1 min-w-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[13px] outline-none focus:border-zinc-500"
      />
      </div>
      {/* onMouseDown preventDefault：不让点勾选框把标题输入框 blur 掉（空标题会关闭新建） */}
      <label
        className="mt-1 flex items-center gap-1 text-[11px] text-zinc-400 select-none"
        onMouseDown={e => e.preventDefault()}
      >
        <input
          type="checkbox"
          checked={!newListable}
          onChange={e => setNewListable(!e.target.checked)}
          className="h-3 w-3"
        />
        <span title="不进目录树：只有被显式分享的人能列到它，其子文档随之隐藏；他人仍可经 [[链接]] 到达（能否读由权限决定）">
          不在目录中列出
        </span>
      </label>
    </div>
  );

  return (
    // 侧栏 sticky 固定高度自滚，不随主体滚走（UI 修缮轮）；主体保持最小视口高
    <div className="flex gap-6 items-start">
      <aside className="w-[264px] shrink-0 sticky top-4 h-[calc(100vh-120px)] flex flex-col rounded-xl border border-zinc-200 bg-white overflow-hidden">
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
                  onDragStart={e => {
                    setDragId(entry.id);
                    e.dataTransfer.effectAllowed = "copyMove";
                    // 拖进编辑器成为双向链接：富文本读 x-clickin-wiki（TipTap handleDrop），
                    // 源码 textarea 靠 text/plain 走浏览器原生插入
                    const label = entry.title ?? "（无标题）";
                    e.dataTransfer.setData("application/x-clickin-wiki", JSON.stringify({ id: entry.id, label }));
                    e.dataTransfer.setData("text/plain", `[#](/__cm__/wiki/${entry.id})`);
                  }}
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
                    onClick={() => setExpanded(prev => {
                      const next = new Set(prev);
                      if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                      return next;
                    })}
                    className={`w-4 shrink-0 text-[10px] text-zinc-400 hover:text-zinc-600 ${hasChildren ? "" : "invisible"}`}
                    aria-label="展开/折叠"
                  >
                    {expanded.has(entry.id) ? "▾" : "▸"}
                  </button>
                  <Link
                    href={`${routeBase}/${entry.id}`}
                    className={`flex-1 min-w-0 truncate py-1.5 text-[13px] ${
                      active ? "font-semibold text-sky-800" : "text-zinc-600"
                    }`}
                    title={entry.title ?? undefined}
                  >
                    {entry.title ?? "（无标题）"}
                  </Link>
                  {!entry.listable && (
                    <span
                      className="shrink-0 text-[10px] text-amber-500 group-hover:hidden"
                      title="不可枚举：只有被显式分享的人能在目录里看到它；其子文档随之隐藏"
                    >
                      ⌀
                    </span>
                  )}
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
          <div className="flex border-t border-zinc-100">
            <button
              type="button"
              onClick={() => { setCreatingUnder(""); setNewTitle(""); }}
              className="flex-1 px-3 py-2 text-left text-[13px] text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50"
            >
              ＋ 新建文档
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              title="导入 markdown 文件（暴力导入：不做链接解析/替换）"
              className="shrink-0 px-3 py-2 text-[13px] text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50 border-l border-zinc-100"
            >
              {importing ? "导入中…" : "导入"}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".md,.markdown,.txt"
              multiple
              className="hidden"
              onChange={e => importFiles(e.target.files)}
            />
          </div>
        )}
      </aside>
      <main className="flex-1 min-w-0 flex flex-col min-h-[calc(100vh-120px)] [&>*]:flex-1">{children}</main>

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
          {/* 系统锚点目录（报告归档）不可删除——服务端亦有 409 拦截 */}
          {byId.get(menu.id)?.isAnchor ? (
            <p className="px-3 py-1.5 text-[12px] text-zinc-400">系统目录，不可删除</p>
          ) : (
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
              onClick={() => remove(menu.id)}
            >
              删除
            </button>
          )}
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
