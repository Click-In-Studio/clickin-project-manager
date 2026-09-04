"use client";

// 文档树侧栏（W4 Notion 式 → #420 node 树）：树承载全部节点操作——新建（根/子）、
// 移动、删除、软链接、树导航。节点四 kind：folder / wiki / asset / link，单数组
// 单邻接表；写路径按 kind 分派到三套 API（wiki 内容路由 / wiki-alias / 通用 node
// 位置路由），漏一处是编译错误而不是静默错写（#358 判别联合的同一个理由）。

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAgentMutation } from "@/lib/agent-mutations";
import { BASE_PATH } from "@/lib/base-path";
import TreePickerModal from "@/components/TreePickerModal";
import AdminModal from "@/components/AdminModal";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import type { NodeEntry } from "@/lib/node/db";
import type { NodeMoveInCandidate } from "@/lib/node/dramaturgy";

type DropZone = "before" | "after" | "inside";

type FlatNode = { item: NodeEntry; depth: number; hasChildren: boolean };

const isContainer = (n: NodeEntry) => n.kind === "wiki" || n.kind === "folder";

export default function WikiShell({
  productionId,
  nodes,
  moveInCandidates = [],
  canCreate,
  selectedId,
  navigationBasePath,
  rootParentId,
  rootAnchor,
  children,
}: {
  productionId: string;
  /** 树节点（#420 单数组四 kind）。服务端已过枚举面 + link 判定式。 */
  nodes: NodeEntry[];
  /** 「移入」候选（#355）：作用域工作区专用。 */
  moveInCandidates?: NodeMoveInCandidate[];
  canCreate: boolean;
  /** 当前路由段：wiki 内容 id 或 link 节点 id（nd_ 前缀）。 */
  selectedId?: string;
  /** Optional route namespace for a scoped wiki workspace. API paths stay unchanged. */
  navigationBasePath?: string;
  /** Parent（node id）used when this shell presents a subtree as its visual root. */
  rootParentId?: string;
  /** 根锚点尚未懒建时的落位声明——服务端过完 create 门后解析成真正的 parentId。 */
  rootAnchor?: "dramaturgy";
  children: React.ReactNode;
}) {
  const router = useRouter();
  // AI 在本制作写了文档 → 树是 server 端算好的 props，软刷新是最小刷新粒度
  const agentRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useAgentMutation({ scope: "wiki", productionId }, () => {
    if (agentRefreshTimer.current) return;
    agentRefreshTimer.current = setTimeout(() => { agentRefreshTimer.current = null; router.refresh(); }, 300);
  });
  const routeBase = navigationBasePath ?? `/production/${productionId}/wiki`;
  const [query, setQuery] = useState("");
  const items = nodes;
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  /** 路由段（wiki 内容 id / link 节点 id）→ 树节点 */
  const selectedItem = useMemo(() => {
    if (!selectedId) return undefined;
    return items.find(i => i.id === selectedId || i.wikiId === selectedId);
  }, [items, selectedId]);

  // 默认全收起；展开状态按 production 持久化 localStorage
  const storageKey = `clickin-wiki-tree-expanded:${productionId}`;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const hydratedRef = useRef(false);

  // 挂载后读回持久化状态（避免 SSR 水合不一致），并展开选中节点的祖先链
  useEffect(() => {
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as string[]; } catch { /* 忽略坏数据 */ }
    setExpanded(prev => {
      const next = new Set([...prev, ...saved]);
      let cur = selectedId
        ? [...byIdRef.current.values()].find(i => i.id === selectedId || i.wikiId === selectedId)
        : undefined;
      while (cur?.parentId) { next.add(cur.parentId); cur = byIdRef.current.get(cur.parentId); }
      return next;
    });
    hydratedRef.current = true;
  }, [storageKey, selectedId]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    try { localStorage.setItem(storageKey, JSON.stringify([...expanded])); } catch { /* 配额满等，忽略 */ }
  }, [expanded, storageKey]);
  // 新建：creatingUnder = null 未在建 / "" 根级 / <node id> 子文档
  const [creatingUnder, setCreatingUnder] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newListable, setNewListable] = useState(true);
  const [busy, setBusy] = useState(false);
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

  // 同层有序邻接表（服务端已按 sort_key 排序，分组后保持相对序）。
  // 只有容器 kind（folder/wiki）能收子项。
  const byParent = useMemo(() => {
    const containerIds = new Set(items.filter(isContainer).map(n => n.id));
    const m = new Map<string | null, NodeEntry[]>();
    for (const it of items) {
      const key = it.parentId && containerIds.has(it.parentId) ? it.parentId : null;
      m.set(key, [...(m.get(key) ?? []), it]);
    }
    return m;
  }, [items]);

  /** 位置面 PATCH 的端点按 kind 分派（内容路由 / alias 路由 / 通用 node 路由） */
  function patchEndpoint(item: NodeEntry): string {
    if (item.kind === "link") return `${BASE_PATH}/api/production/${productionId}/wiki-alias/${item.id}`;
    if (item.kind === "wiki" && item.wikiId) return `${BASE_PATH}/api/production/${productionId}/wiki/${item.wikiId}`;
    return `${BASE_PATH}/api/production/${productionId}/node/${item.id}`;
  }

  /** 树内导航目标：wiki=内容 id 路由段；link=节点 id（页面就地渲染目标）；
   *  asset=资产预览页；folder=无导航（点击展开）。 */
  function hrefFor(item: NodeEntry): string | null {
    if (item.kind === "wiki" && item.wikiId) return `${routeBase}/${item.wikiId}`;
    if (item.kind === "link") return `${routeBase}/${item.id}`;
    if (item.kind === "asset" && item.assetId)
      return `/production/${productionId}/assets/${item.assetId}/preview`;
    return null;
  }

  // ── 拖拽调层级（Notion 式）──────────────────────────────────────────────────
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; zone: DropZone } | null>(null);

  const dragDescendants = useMemo(() => {
    if (!dragId) return new Set<string>();
    const set = new Set([dragId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const it of items) {
        if (it.parentId && set.has(it.parentId) && !set.has(it.id)) { set.add(it.id); grew = true; }
      }
    }
    return set;
  }, [dragId, items]);

  async function performDrop(targetId: string, zone: DropZone) {
    const id = dragId;
    setDragId(null);
    setDropHint(null);
    if (!id || id === targetId || dragDescendants.has(targetId)) return;
    const target = byId.get(targetId);
    const dragged = byId.get(id);
    if (!target || !dragged) return;
    // 叶子 kind（link/asset）不能收子项
    if (zone === "inside" && !isContainer(target)) return;

    // 排序键一律由服务端在**完整**兄弟集上算（#357 症状②），这里只声明锚点
    const parentId = zone === "inside"
      ? targetId
      : rootParentId && target.parentId === rootParentId ? null : target.parentId ?? null;
    const place = zone === "inside" ? undefined : { anchorId: targetId, side: zone };

    const res = await fetch(patchEndpoint(dragged), {
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
      for (const it of items) {
        const hit = (it.displayTitle ?? "").toLowerCase().includes(q)
          || it.tags.some(t => t.toLowerCase().includes(q));
        if (!hit) continue;
        let cur: NodeEntry | undefined = it;
        while (cur && !visible.has(cur.id)) {
          visible.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
    }
    const out: FlatNode[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const it of byParent.get(parent) ?? []) {
        if (visible && !visible.has(it.id)) continue;
        const hasChildren = isContainer(it) && (byParent.get(it.id) ?? []).length > 0;
        out.push({ item: it, depth, hasChildren });
        if (isContainer(it) && (expanded.has(it.id) || q)) walk(it.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [items, query, expanded, byId, byParent]);

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
    const it = byId.get(id);
    if (!it) return;
    if (it.kind === "link") {
      if (!confirm(`确认移除链接「${it.displayTitle ?? "（无标题）"}」？目标不受影响。`)) return;
      setMenu(null);
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki-alias/${id}`,
        { method: "DELETE" });
      if (!res.ok) { alert((await res.json()).error ?? "移除失败"); return; }
      if (id === selectedId) router.push(routeBase);
      router.refresh();
      return;
    }
    if (it.kind !== "wiki" || !it.wikiId) return; // asset/folder 的删除入口不在树上（批1）
    // 指向本节点的软链接会随删（FK 级联）——只数得出自己看得见的那些
    const linked = items.filter(n => n.kind === "link" && n.linkTargetId === id).length;
    const extra = linked > 0 ? `\n指向它的链接（至少 ${linked} 处）也会一并移除。` : "";
    if (!confirm(`确认删除「${it.displayTitle ?? "该文档"}」？子节点将上移一层。${extra}`)) return;
    setMenu(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${it.wikiId}`, { method: "DELETE" });
    if (!res.ok) { alert((await res.json()).error ?? "删除失败"); return; }
    if (selectedItem?.id === id) router.push(routeBase);
    router.refresh();
  }

  /** 落到本工作区**顶层**的落位载荷（根懒建时声明锚点，#355）。 */
  function rootPlacement(): { parentId: string | null; parentAnchor?: "dramaturgy" } {
    if (rootParentId) return { parentId: rootParentId };
    return { parentId: null, ...(rootAnchor ? { parentAnchor: rootAnchor } : {}) };
  }

  async function move(id: string, targetIds: string[]) {
    setMovingId(null);
    const target = targetIds[0];
    if (target === undefined) return;
    const it = byId.get(id);
    if (!it) return;
    const res = await fetch(patchEndpoint(it), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target === "__root__" ? rootPlacement() : { parentId: target }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "移动失败"); return; }
    router.refresh();
  }

  // 软链接（#358 → #420）：在另一个位置放一个指向本节点的 link，本体一动不动。
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  async function renameAlias(id: string, displayTitle: string | null) {
    setRenamingId(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki-alias/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayTitle }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "重命名失败"); return; }
    router.refresh();
  }

  async function createAlias(targetNodeId: string, targetIds: string[]) {
    setLinkingId(null);
    const target = targetIds[0];
    if (target === undefined) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki-alias`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(target === "__root__" ? rootPlacement() : { parentId: target }),
        targetNodeId,
      }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "创建链接失败"); return; }
    if (target !== "__root__") setExpanded(prev => new Set([...prev, target]));
    router.refresh();
  }

  // ── 移入（#355）────────────────────────────────────────────────────────────
  const [movingInPick, setMovingInPick] = useState(false);
  const [movingIn, setMovingIn] = useState<NodeMoveInCandidate | null>(null);

  async function moveInBody(c: NodeMoveInCandidate) {
    setMovingIn(null);
    // canMoveBody 只对 wiki 节点为真（灰化镜像），本体移入走内容路由
    if (c.kind !== "wiki" || !c.wikiId) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${c.wikiId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rootPlacement()),
    });
    if (!res.ok) { alert((await res.json()).error ?? "移入失败"); return; }
    router.push(`${routeBase}/${c.wikiId}`);
    router.refresh();
  }

  async function moveInLink(c: NodeMoveInCandidate) {
    setMovingIn(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki-alias`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rootPlacement(), targetNodeId: c.id }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error ?? "移入失败"); return; }
    router.push(`${routeBase}/${data.alias.id}`);
    router.refresh();
  }

  /** 容器候选（folder/wiki 才能当容器）。排除自身与后代。 */
  function containerItemsFor(excludeRootId: string | null) {
    const descendants = new Set(excludeRootId ? [excludeRootId] : []);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of items) {
        if (n.parentId && descendants.has(n.parentId) && !descendants.has(n.id)) {
          descendants.add(n.id); grew = true;
        }
      }
    }
    return [
      { id: "__root__", label: "（移到顶层）" },
      ...items.filter(n => isContainer(n) && !descendants.has(n.id)).map(n => ({
        id: n.id, label: n.displayTitle ?? "（无标题）", parentId: n.parentId,
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
        <button
          type="button"
          disabled={!newTitle.trim() || busy}
          onMouseDown={e => e.preventDefault()}
          onClick={() => void create(parentId || null)}
          className="shrink-0 rounded border border-zinc-300 px-2 py-0.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "创建中" : "创建"}
        </button>
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
    <div className="flex gap-6 items-start">
      <aside className="w-[264px] shrink-0 sticky top-4 h-[calc(100vh-120px)] flex flex-col rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="p-2.5 border-b border-zinc-200">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索文档 / 标签…"
            className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-400"
          />
        </div>
        {canCreate && (
          <div className="flex border-b border-zinc-200 bg-zinc-50/40">
            <button
              type="button"
              onClick={() => { setCreatingUnder(""); setNewTitle(""); }}
              className="flex-1 px-3 py-2 text-left text-[13px] text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100/80"
            >
              ＋ 新建文档
            </button>
            {moveInCandidates.length > 0 && (
              <button
                type="button"
                onClick={() => setMovingInPick(true)}
                title="把「文档」模块里已有的一篇带进本工作区"
                className="shrink-0 px-3 py-2 text-[13px] text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100/80 border-l border-zinc-200"
              >
                移入
              </button>
            )}
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              title="导入 markdown 文件（暴力导入：不做链接解析/替换）"
              className="shrink-0 px-3 py-2 text-[13px] text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100/80 border-l border-zinc-200"
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
        <nav className="py-1 flex-1 overflow-y-auto">
          {flat.length === 0 && !creatingUnder && (
            <p className="px-3 py-3 text-sm text-zinc-400">{query ? "无匹配节点" : "还没有可见的文档"}</p>
          )}
          {flat.map(({ item, depth, hasChildren }) => {
            const isLink = item.kind === "link";
            const active = selectedItem?.id === item.id;
            const hint = dropHint?.id === item.id ? dropHint.zone : null;
            const droppable = dragId && dragId !== item.id && !dragDescendants.has(item.id);
            const href = hrefFor(item);
            const rowTitleNode = (
              <>
                {isLink && <span className="mr-1 text-[10px] text-zinc-400">↗</span>}
                {item.kind === "asset" && <span className="mr-1 text-[10px] text-zinc-400">▤</span>}
                {item.kind === "folder" && <span className="mr-1 text-[10px] text-zinc-400">▣</span>}
                {item.displayTitle ?? "（无标题）"}
              </>
            );
            return (
              <div key={item.id}>
                <div
                  draggable
                  onDragStart={e => {
                    setDragId(item.id);
                    e.dataTransfer.effectAllowed = "copyMove";
                    // 拖进编辑器成为双向链接：引用永远锚**真实 wiki 目标**（#358 ⑦）。
                    const refWikiId = item.kind === "wiki" ? item.wikiId
                      : item.kind === "link" ? item.targetWikiId : null;
                    if (refWikiId) {
                      const label = item.displayTitle ?? "（无标题）";
                      e.dataTransfer.setData("application/x-clickin-wiki", JSON.stringify({ id: refWikiId, label }));
                      e.dataTransfer.setData("text/plain", `[#](/__cm__/wiki/${refWikiId})`);
                    }
                  }}
                  onDragEnd={() => { setDragId(null); setDropHint(null); }}
                  onDragOver={e => {
                    if (!droppable) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const r = e.currentTarget.getBoundingClientRect();
                    const y = (e.clientY - r.top) / r.height;
                    // 叶子（link/asset）不能当容器，中部落点退化为"放在它后面"
                    const raw: DropZone = y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
                    const zone: DropZone = !isContainer(item) && raw === "inside" ? "after" : raw;
                    setDropHint(prev => prev?.id === item.id && prev.zone === zone ? prev : { id: item.id, zone });
                  }}
                  onDragLeave={() => setDropHint(prev => (prev?.id === item.id ? null : prev))}
                  onDrop={e => { e.preventDefault(); if (droppable && hint) performDrop(item.id, hint); }}
                  className={`group flex items-center gap-0.5 pr-1.5 rounded-md mx-1 ${
                    hint === "inside" ? "bg-sky-100 ring-1 ring-sky-300"
                    : active ? "bg-sky-50" : "hover:bg-zinc-50"
                  } ${dragId === item.id ? "opacity-40" : ""}`}
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
                      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                      return next;
                    })}
                    className={`w-4 shrink-0 text-[10px] text-zinc-400 hover:text-zinc-600 ${hasChildren ? "" : "invisible"}`}
                    aria-label="展开/折叠"
                  >
                    {expanded.has(item.id) ? "▾" : "▸"}
                  </button>
                  {renamingId === item.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") renameAlias(item.id, renameValue);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => setRenamingId(null)}
                      placeholder="留空＝跟随目标标题"
                      className="flex-1 min-w-0 my-1 rounded border border-zinc-300 px-1.5 py-0.5 text-[13px] outline-none focus:border-zinc-500"
                    />
                  ) : href ? (
                    <Link
                      href={href}
                      className={`flex-1 min-w-0 truncate py-1.5 text-[13px] ${
                        active ? "font-semibold text-sky-800" : "text-zinc-600"
                      }`}
                      title={isLink
                        ? `链接 → ${item.targetTitle ?? "（无标题）"}`
                        : item.displayTitle ?? undefined}
                    >
                      {rowTitleNode}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setExpanded(prev => {
                        const next = new Set(prev);
                        if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                        return next;
                      })}
                      className="flex-1 min-w-0 truncate py-1.5 text-left text-[13px] text-zinc-600"
                      title={item.displayTitle ?? undefined}
                    >
                      {rowTitleNode}
                    </button>
                  )}
                  {item.kind !== "link" && !item.listable && (
                    <span
                      className="shrink-0 text-[10px] text-amber-500 group-hover:hidden"
                      title="不可枚举：只有被显式分享的人能在目录里看到它；其子节点随之隐藏"
                    >
                      ⌀
                    </span>
                  )}
                  {item.kind !== "link" && item.isPublic && (
                    <span className="shrink-0 text-[10px] text-zinc-300 group-hover:hidden" title="已公开给全体成员">◍</span>
                  )}
                  {/* 悬停操作区：＋ 新建子文档（容器 kind 才有）/ ⋯ 菜单 */}
                  <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                    {canCreate && isContainer(item) && (
                      <button
                        type="button"
                        title="新建子文档"
                        onClick={() => { setCreatingUnder(item.id); setNewTitle(""); setMenu(null); }}
                        className="w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/60 text-sm leading-none"
                      >
                        ＋
                      </button>
                    )}
                    <button
                      type="button"
                      title="更多操作"
                      onClick={e => {
                        if (menu?.id === item.id) { setMenu(null); return; }
                        const r = e.currentTarget.getBoundingClientRect();
                        setMenu({ id: item.id, top: r.bottom + 2, left: Math.max(8, r.right - 148) });
                      }}
                      className="w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/60 text-sm leading-none"
                    >
                      ⋯
                    </button>
                  </div>
                </div>
                {creatingUnder === item.id && newDocInput(item.id, depth + 1)}
              </div>
            );
          })}
          {creatingUnder === "" && newDocInput("", 0)}
        </nav>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col min-h-[calc(100vh-120px)] [&>*]:flex-1">{children}</main>

      {menu && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: menu.top, left: menu.left, zIndex: 9999 }}
          className="w-36 rounded-lg border border-zinc-200 bg-white shadow-lg py-1"
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
            onClick={() => { const id = menu.id; setMenu(null); setMovingId(id); }}
          >
            移动到…
          </button>
          {/* 软链接：wiki/asset 节点可被链接；link 不能再被链接（链式结构上不存在） */}
          {(() => {
            const it = byId.get(menu.id);
            return it && (it.kind === "wiki" || it.kind === "asset") && canCreate ? (
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
                onClick={() => { const id = menu.id; setMenu(null); setLinkingId(id); }}
              >
                链接到…
              </button>
            ) : null;
          })()}
          {byId.get(menu.id)?.kind === "link" && (
            <>
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
                onClick={() => {
                  const it = byId.get(menu.id);
                  setMenu(null);
                  setRenameValue(it?.kind === "link" ? it.title ?? "" : "");
                  setRenamingId(menu.id);
                }}
              >
                重命名
              </button>
              {byId.get(menu.id)?.title !== null && (
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
                  onClick={() => { const id = menu.id; setMenu(null); renameAlias(id, null); }}
                >
                  改回目标标题
                </button>
              )}
            </>
          )}
          {(() => {
            const it = byId.get(menu.id);
            if (!it) return null;
            if (it.isAnchor)
              return <p className="px-3 py-1.5 text-[12px] text-zinc-400">系统目录，不可删除</p>;
            if (it.kind === "asset")
              return <p className="px-3 py-1.5 text-[12px] text-zinc-400">资产请在资产页删除</p>;
            if (it.kind === "folder")
              return null; // 批1 folder 全是系统产物，无删除入口
            return (
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
                onClick={() => remove(menu.id)}
              >
                {it.kind === "link" ? "移除链接" : "删除"}
              </button>
            );
          })()}
        </div>,
        document.body,
      )}

      {movingId && (() => {
        const it = byId.get(movingId);
        // link 不得落进目标自己的子树（服务端亦拦）——候选里就不给
        const excludeRoot = it?.kind === "link" ? it.linkTargetId : movingId;
        return (
          <TreePickerModal
            kicker="Wiki"
            title={`移动「${it?.displayTitle ?? ""}」到…`}
            items={containerItemsFor(excludeRoot)}
            preselected={[]}
            single
            onConfirm={ids => move(movingId, ids)}
            onClose={() => setMovingId(null)}
          />
        );
      })()}

      {linkingId && (
        <TreePickerModal
          kicker="Wiki"
          title={`把「${byId.get(linkingId)?.displayTitle ?? ""}」链接到…`}
          items={containerItemsFor(linkingId)}
          preselected={[]}
          single
          onConfirm={ids => createAlias(linkingId, ids)}
          onClose={() => setLinkingId(null)}
        />
      )}

      {movingInPick && (
        <TreePickerModal
          kicker="Wiki"
          title="移入文档"
          items={moveInCandidates.map(c => ({
            id: c.id,
            label: c.title ?? "（无标题）",
            parentId: c.parentId,
            ...(c.linked ? { badge: "已有链接" } : {}),
          }))}
          preselected={[]}
          single
          onConfirm={ids => {
            setMovingInPick(false);
            const picked = moveInCandidates.find(c => c.id === ids[0]);
            if (picked) setMovingIn(picked);
          }}
          onClose={() => setMovingInPick(false)}
        />
      )}

      {movingIn && (() => {
        const c = movingIn;
        const preferLink = c.parentId !== null;
        return (
          <AdminModal
            kicker="Wiki"
            title={`移入「${c.title ?? "（无标题）"}」`}
            onClose={() => setMovingIn(null)}
            width={420}
          >
            <div className="flex flex-col gap-3">
              <button
                type="button"
                disabled={!c.canMoveBody}
                onClick={() => moveInBody(c)}
                style={{
                  ...(preferLink || !c.canMoveBody ? SECONDARY_BTN : PRIMARY_BTN),
                  ...(c.canMoveBody ? {} : { opacity: 0.4, cursor: "not-allowed" }),
                }}
                className="text-left"
              >
                移入本体
              </button>
              <p className="-mt-2 text-[12px] text-zinc-500">
                {c.canMoveBody
                  ? "它从原位置消失，只出现在这里。"
                  : "你没有这个节点（或它所在目录）的编辑权，改不了它的位置。"}
              </p>
              <button
                type="button"
                onClick={() => moveInLink(c)}
                style={preferLink || !c.canMoveBody ? PRIMARY_BTN : SECONDARY_BTN}
                className="text-left"
              >
                建链接
              </button>
              <p className="-mt-2 text-[12px] text-zinc-500">
                原位置不动，这里多一个指向它的位置。内容只有一份，改哪边都是同一份。
                {c.linked && "（这里已经有指向它的链接了）"}
              </p>
            </div>
          </AdminModal>
        );
      })()}
    </div>
  );
}
