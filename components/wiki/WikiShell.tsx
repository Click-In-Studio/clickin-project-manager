"use client";

// wiki 文档库 W4（Notion 式改版）：文档树侧栏承载全部文档操作——
// 新建（根/子文档，行悬停 ＋）、移动、删除（行悬停 ⋯ 菜单）、树导航。
// 树逻辑：邻接表→DFS 展开 + 搜索保留祖先链 + 展开/折叠态。

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAgentMutation } from "@/lib/agent-mutations";
import { BASE_PATH } from "@/lib/base-path";
import TreePickerModal from "@/components/TreePickerModal";
import AdminModal from "@/components/AdminModal";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import type { WikiListEntry } from "@/lib/wiki-db";
import type { WikiAliasEntry } from "@/lib/wiki-alias-db";
import type { WikiMoveInCandidate } from "@/lib/dramaturgy-wiki";

type DropZone = "before" | "after" | "inside";

// 树的节点集 = 可枚举的文档 ∪ 可枚举的软链接别名（#358）。别名是**叶子**：只链
// 那一篇，不展开目标的子文档，也不能在它下面新建——所以 hasChildren 恒 false、
// 没有 ＋ 按钮、不能作为 "inside" 落点。
// 判别联合而不是往 WikiListEntry 上加可空字段：写路径按 kind 分派到两套 API，
// 漏一处是编译错误而不是静默把别名当文档写（#358 选独立表的同一个理由）。
type TreeItem =
  | { kind: "wiki"; id: string; parentId: string | null; sortKey: string | null;
      createdAt: string; title: string | null; entry: WikiListEntry }
  | { kind: "alias"; id: string; parentId: string | null; sortKey: string | null;
      createdAt: string; title: string | null; alias: WikiAliasEntry };

type Node = { item: TreeItem; depth: number; hasChildren: boolean };

export default function WikiShell({
  productionId,
  wikis,
  aliases = [],
  moveInCandidates = [],
  canCreate,
  selectedId,
  navigationBasePath,
  rootParentId,
  rootAnchor,
  children,
}: {
  productionId: string;
  wikis: WikiListEntry[];
  /** 软链接别名（#358）。服务端已过判定式：父可枚举 ∧ 本地可枚举(目标)。 */
  aliases?: WikiAliasEntry[];
  /**
   * 「移入」候选（#355）：**作用域工作区专用**——子树外、该用户可枚举的文档。
   * 不给它就没有移入入口：完整文档库里全库本来就在树上，"移入"无从谈起。
   */
  moveInCandidates?: WikiMoveInCandidate[];
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
  // AI 在本制作写了文档（建/改/删/移动/标签/授权）→ 树是 server 端算好的 props，软刷新
  // 是这里最小的刷新粒度；连写几篇合并成一次。正文的同步不走这里（协作 SSE）。
  const agentRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useAgentMutation({ scope: "wiki", productionId }, () => {
    if (agentRefreshTimer.current) return;
    agentRefreshTimer.current = setTimeout(() => { agentRefreshTimer.current = null; router.refresh(); }, 300);
  });
  const routeBase = navigationBasePath ?? `/production/${productionId}/wiki`;
  const [query, setQuery] = useState("");
  // 合并两种节点，按同一把尺排序（服务端 sort_key 就是在并集上取的，见 wiki-db.siblingRows）
  const items = useMemo<TreeItem[]>(() => {
    const merged: TreeItem[] = [
      ...wikis.map((w): TreeItem => ({
        kind: "wiki", id: w.id, parentId: w.parentId, sortKey: w.sortKey,
        createdAt: w.createdAt, title: w.title, entry: w,
      })),
      ...aliases.map((a): TreeItem => ({
        kind: "alias", id: a.id, parentId: a.parentId, sortKey: a.sortKey,
        createdAt: a.createdAt, title: a.title, alias: a,
      })),
    ];
    return merged.sort((x, y) =>
      (x.sortKey ?? "\uffff").localeCompare(y.sortKey ?? "\uffff")
      || x.createdAt.localeCompare(y.createdAt));
  }, [wikis, aliases]);
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
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

  // 同层有序邻接表（items 已按 sort_key NULLS LAST, createdAt 排序，分组后保持相对序）。
  // 别名的父只能是真实文档，所以归组时只认 wiki 侧的 id 集。
  const byParent = useMemo(() => {
    const wikiIds = new Set(wikis.map(w => w.id));
    const m = new Map<string | null, TreeItem[]>();
    for (const it of items) {
      const key = it.parentId && wikiIds.has(it.parentId) ? it.parentId : null;
      m.set(key, [...(m.get(key) ?? []), it]);
    }
    return m;
  }, [items, wikis]);

  // ── 拖拽调层级（Notion 式：行上/下缘=同级排序，行中部=成为子文档）──────────
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
    if (!target) return;
    // 别名是叶子：不能往它"里面"放东西（#358）
    if (zone === "inside" && target.kind === "alias") return;
    const dragged = byId.get(id);

    // 排序键一律由服务端在**完整**兄弟集上算（#357 症状②）：可枚举性逐节点后
    // 客户端手里的兄弟集可能有空洞，在残缺集上取键会和看不见的兄弟交错。
    // 这里只声明「挂到谁下面 / 放在谁的前后」，不自己算键。
    const parentId = zone === "inside"
      ? targetId
      : rootParentId && target.parentId === rootParentId ? null : target.parentId ?? null;
    const place = zone === "inside" ? undefined : { anchorId: targetId, side: zone };

    const endpoint = dragged?.kind === "alias"
      ? `${BASE_PATH}/api/production/${productionId}/wiki-alias/${id}`
      : `${BASE_PATH}/api/production/${productionId}/wiki/${id}`;
    const res = await fetch(endpoint, {
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
        const hit = (it.title ?? "").toLowerCase().includes(q)
          || (it.kind === "wiki" && it.entry.tags.some(t => t.toLowerCase().includes(q)));
        if (!hit) continue;
        let cur: TreeItem | undefined = it;
        while (cur && !visible.has(cur.id)) {
          visible.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
    }
    const out: Node[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const it of byParent.get(parent) ?? []) {
        if (visible && !visible.has(it.id)) continue;
        // 别名恒为叶子（#358）：它下面永远不展开东西
        const hasChildren = it.kind === "wiki" && (byParent.get(it.id) ?? []).length > 0;
        out.push({ item: it, depth, hasChildren });
        if (it.kind === "wiki" && (expanded.has(it.id) || q)) walk(it.id, depth + 1);
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
    if (it?.kind === "alias") {
      if (!confirm(`确认移除链接「${it.title ?? "（无标题）"}」？目标文档不受影响。`)) return;
      setMenu(null);
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki-alias/${id}`,
        { method: "DELETE" });
      if (!res.ok) { alert((await res.json()).error ?? "移除失败"); return; }
      if (id === selectedId) router.push(routeBase);
      router.refresh();
      return;
    }
    // 指向本篇的软链接会随删（服务端在同一事务内清）——只数得出自己看得见的那些，
    // 所以措辞是"至少"，不给一个会撒谎的精确数字
    const linked = aliases.filter(a => a.targetType === "wiki" && a.targetId === id).length;
    const extra = linked > 0 ? `\n指向它的链接（至少 ${linked} 处）也会一并移除。` : "";
    if (!confirm(`确认删除「${it?.title ?? "该文档"}」？子文档将上移一层。${extra}`)) return;
    setMenu(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${id}`, { method: "DELETE" });
    if (!res.ok) { alert((await res.json()).error ?? "删除失败"); return; }
    if (id === selectedId) router.push(routeBase);
    router.refresh();
  }

  /**
   * 落到本工作区**顶层**的落位载荷。作用域工作区的根是懒建的：一篇都还没有时
   * rootParentId 是空的，此时不能直接送 parentId:null（那是**全库**顶层，文档会
   * 掉出工作区），而是声明锚点、由服务端过完门后补建根（#355）。
   */
  function rootPlacement(): { parentId: string | null; parentAnchor?: "dramaturgy" } {
    if (rootParentId) return { parentId: rootParentId };
    return { parentId: null, ...(rootAnchor ? { parentAnchor: rootAnchor } : {}) };
  }

  async function move(id: string, targetIds: string[]) {
    setMovingId(null);
    const target = targetIds[0];
    if (target === undefined) return;
    const kind = byId.get(id)?.kind;
    const endpoint = kind === "alias"
      ? `${BASE_PATH}/api/production/${productionId}/wiki-alias/${id}`
      : `${BASE_PATH}/api/production/${productionId}/wiki/${id}`;
    const res = await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target === "__root__" ? rootPlacement() : { parentId: target }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "移动失败"); return; }
    router.refresh();
  }

  // 软链接（#358）：在另一个位置放一个指向本篇的伪节点，本篇一动不动。
  const [linkingId, setLinkingId] = useState<string | null>(null);
  // 别名显示名（#358 ⑤）：只改这个位置上的标签，目标标题不动；清空＝改回跟随目标
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

  async function createAlias(targetId: string, targetIds: string[]) {
    setLinkingId(null);
    const target = targetIds[0];
    if (target === undefined) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki-alias`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(target === "__root__" ? rootPlacement() : { parentId: target }),
        targetType: "wiki",
        targetId,
      }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "创建链接失败"); return; }
    if (target !== "__root__") setExpanded(prev => new Set([...prev, target]));
    router.refresh();
  }

  // ── 移入（#355）：把子树外的一篇文档带进本工作区 ────────────────────────────
  // 两种形态是**同一个入口**的两个选项，不拆成两个功能：
  //   本体移入 —— 改 parent_id，它从原位置消失、出现在这里
  //   建链接   —— 原位置不动，这里多一个指向它的位置（#358 的伪节点）
  // 两者的门不同档：本体移入要 canEditWiki(本篇) ∧ 源父容器可写，建链接只要
  // wiki@create ∧ 目标可达——所以"只能建链接、不能移本体"是常态，不是异常。
  const [movingInPick, setMovingInPick] = useState(false);
  const [movingIn, setMovingIn] = useState<WikiMoveInCandidate | null>(null);

  async function moveInBody(c: WikiMoveInCandidate) {
    setMovingIn(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rootPlacement()),
    });
    if (!res.ok) { alert((await res.json()).error ?? "移入失败"); return; }
    router.push(`${routeBase}/${c.id}`);
    router.refresh();
  }

  async function moveInLink(c: WikiMoveInCandidate) {
    setMovingIn(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki-alias`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rootPlacement(), targetType: "wiki", targetId: c.id }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error ?? "移入失败"); return; }
    router.push(`${routeBase}/${data.alias.id}`);
    router.refresh();
  }

  /** 容器候选（只有真实文档能当容器——别名是叶子）。排除自身与后代。 */
  function containerItemsFor(id: string | null) {
    const descendants = new Set(id ? [id] : []);
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
          {flat.map(({ item, depth, hasChildren }) => {
            const entry = item.kind === "wiki" ? item.entry : null;
            const isAlias = item.kind === "alias";
            const active = item.id === selectedId;
            const hint = dropHint?.id === item.id ? dropHint.zone : null;
            const droppable = dragId && dragId !== item.id && !dragDescendants.has(item.id);
            return (
              <div key={item.id}>
                <div
                  draggable
                  onDragStart={e => {
                    setDragId(item.id);
                    e.dataTransfer.effectAllowed = "copyMove";
                    // 拖进编辑器成为双向链接：富文本读 x-clickin-wiki（TipTap handleDrop），
                    // 源码 textarea 靠 text/plain 走浏览器原生插入。
                    // 别名一律给**真实目标 id**——引用边绝不锚别名（#358 ⑦），
                    // 否则别名一挪，引用就断（#302 为 cue 解决过的同构问题）。
                    const label = item.title ?? "（无标题）";
                    const refId = item.kind === "alias" ? item.alias.targetId : item.id;
                    e.dataTransfer.setData("application/x-clickin-wiki", JSON.stringify({ id: refId, label }));
                    e.dataTransfer.setData("text/plain", `[#](/__cm__/wiki/${refId})`);
                  }}
                  onDragEnd={() => { setDragId(null); setDropHint(null); }}
                  onDragOver={e => {
                    if (!droppable) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const r = e.currentTarget.getBoundingClientRect();
                    const y = (e.clientY - r.top) / r.height;
                    // 别名不能当容器（叶子），中部落点退化为"放在它后面"
                    const raw: DropZone = y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
                    const zone: DropZone = isAlias && raw === "inside" ? "after" : raw;
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
                  ) : (
                    <Link
                      href={`${routeBase}/${item.id}`}
                      className={`flex-1 min-w-0 truncate py-1.5 text-[13px] ${
                        active ? "font-semibold text-sky-800" : "text-zinc-600"
                      }`}
                      title={item.kind === "alias"
                        ? `链接 → ${item.alias.targetTitle ?? "（无标题）"}`
                        : item.title ?? undefined}
                    >
                      {isAlias && <span className="mr-1 text-[10px] text-zinc-400">↗</span>}
                      {item.title ?? "（无标题）"}
                    </Link>
                  )}
                  {entry && !entry.listable && (
                    <span
                      className="shrink-0 text-[10px] text-amber-500 group-hover:hidden"
                      title="不可枚举：只有被显式分享的人能在目录里看到它；其子文档随之隐藏"
                    >
                      ⌀
                    </span>
                  )}
                  {entry?.isPublic && (
                    <span className="shrink-0 text-[10px] text-zinc-300 group-hover:hidden" title="已公开给全体成员">◍</span>
                  )}
                  {/* 悬停操作区：＋ 新建子文档（别名是叶子，没有）/ ⋯ 菜单 */}
                  <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                    {canCreate && !isAlias && (
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
        {canCreate && (
          <div className="flex border-t border-zinc-100">
            <button
              type="button"
              onClick={() => { setCreatingUnder(""); setNewTitle(""); }}
              className="flex-1 px-3 py-2 text-left text-[13px] text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50"
            >
              ＋ 新建文档
            </button>
            {/* 移入（#355）：把子树外的文档带进本工作区。只有作用域工作区给候选。 */}
            {moveInCandidates.length > 0 && (
              <button
                type="button"
                onClick={() => setMovingInPick(true)}
                title="把「文档」模块里已有的一篇带进本工作区"
                className="shrink-0 px-3 py-2 text-[13px] text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50 border-l border-zinc-100"
              >
                移入
              </button>
            )}
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
          className="w-36 rounded-lg border border-zinc-200 bg-white shadow-lg py-1"
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
            onClick={() => { const id = menu.id; setMenu(null); setMovingId(id); }}
          >
            移动到…
          </button>
          {/* 软链接：在别处放一个指向本篇的伪节点，本篇不动（#358）。别名不能再被
              软链接——链式别名结构上不存在，建的时候就解析到最终目标。 */}
          {byId.get(menu.id)?.kind === "wiki" && canCreate && (
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
              onClick={() => { const id = menu.id; setMenu(null); setLinkingId(id); }}
            >
              链接到…
            </button>
          )}
          {/* 显示名只改这个位置上的标签，目标标题不动（#358 ⑤） */}
          {byId.get(menu.id)?.kind === "alias" && (
            <>
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
                onClick={() => {
                  const it = byId.get(menu.id);
                  setMenu(null);
                  setRenameValue(it?.kind === "alias" ? it.alias.displayTitle ?? "" : "");
                  setRenamingId(menu.id);
                }}
              >
                重命名
              </button>
              {byId.get(menu.id)?.kind === "alias"
                && (byId.get(menu.id) as { alias: WikiAliasEntry }).alias.displayTitle !== null && (
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
          {/* 系统锚点目录（报告归档）不可删除——服务端亦有 409 拦截 */}
          {(() => {
            const it = byId.get(menu.id);
            if (it?.kind === "wiki" && it.entry.isAnchor)
              return <p className="px-3 py-1.5 text-[12px] text-zinc-400">系统目录，不可删除</p>;
            return (
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
                onClick={() => remove(menu.id)}
              >
                {it?.kind === "alias" ? "移除链接" : "删除"}
              </button>
            );
          })()}
        </div>,
        document.body,
      )}

      {movingId && (() => {
        const it = byId.get(movingId);
        // 别名不得落进目标自己的子树（服务端亦拦）——候选里就不给
        const excludeRoot = it?.kind === "alias" ? it.alias.targetId : movingId;
        return (
          <TreePickerModal
            kicker="Wiki"
            title={`移动「${it?.title ?? ""}」到…`}
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
          title={`把「${byId.get(linkingId)?.title ?? ""}」链接到…`}
          items={containerItemsFor(linkingId)}
          preselected={[]}
          single
          onConfirm={ids => createAlias(linkingId, ids)}
          onClose={() => setLinkingId(null)}
        />
      )}

      {/* 移入第一步：选一篇子树外的文档。候选已在服务端过完枚举面——列不到的
          文档不会出现在这里，也就不存在"选了个自己看不见的 id"这回事。 */}
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

      {/* 移入第二步：本体还是链接。默认按上下文——游离文档（没有父）默认移本体，
          已经挂在别处的默认建链接（那个位置多半有人在用，抽走本体是对别人的改动）。
          「移入本体」在无权时灰掉而不是隐藏：让人看见这条路存在、且为什么走不通。 */}
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
                  // 内联样式压过 tailwind 的 disabled:*，灰化只能也写在这里
                  ...(c.canMoveBody ? {} : { opacity: 0.4, cursor: "not-allowed" }),
                }}
                className="text-left"
              >
                移入本体
              </button>
              <p className="-mt-2 text-[12px] text-zinc-500">
                {c.canMoveBody
                  ? "它从原位置消失，只出现在这里。"
                  : "你没有这篇文档（或它所在目录）的编辑权，改不了它的位置。"}
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
                原位置不动，这里多一个指向它的位置。正文只有一份，改哪边都是同一篇。
                {c.linked && "（这里已经有指向它的链接了）"}
              </p>
            </div>
          </AdminModal>
        );
      })()}
    </div>
  );
}
