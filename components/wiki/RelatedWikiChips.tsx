"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";

type WikiRef = { id: string; title: string | null; manual: boolean };

// 对象侧"相关 wiki"面板：引用了该实体的 wiki 标题 chip。
// 标题级列出（§4.1）——含观看者无权阅读的文档，点击处由 wiki 页过门+申请。
// canEdit 时暴露 manual 边的建/解入口（body 边只能改正文，不给 ×）；
// createDefaultTitle 存在时提供"新建并跳转"流（新文档落「戏剧构作」根 + 自动建边）。
// 只读且空列表时整块不渲染（多数对象没被提过，不占版面）。
export default function RelatedWikiChips({
  productionId, entityType, entityId, canEdit = false, createDefaultTitle, onNavigate,
}: {
  productionId: string;
  entityType: "scene" | "rehearsal" | "block" | "cue" | "asset";
  entityId: string;
  canEdit?: boolean;
  /** 提供即启用"新建文档"入口（如「第3场 · 大纲」），创建后跳 wiki 页写作 */
  createDefaultTitle?: string;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [refs, setRefs] = useState<WikiRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; title: string | null }[]>([]);
  const searchSeq = useRef(0);

  const api = `${BASE_PATH}/api/production/${productionId}/wiki-refs`;
  const qs = `type=${entityType}&id=${encodeURIComponent(entityId)}`;

  const load = useCallback(() => {
    fetch(`${api}?${qs}`)
      .then(r => (r.ok ? r.json() : { refs: [] }))
      .then(d => setRefs(d.refs ?? []))
      .catch(() => setRefs([]));
  }, [api, qs]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!picking || !query.trim()) { setResults([]); return; }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      fetch(`${BASE_PATH}/api/production/${productionId}/wiki?q=${encodeURIComponent(query.trim())}`)
        .then(r => (r.ok ? r.json() : { results: [] }))
        .then(d => { if (seq === searchSeq.current) setResults(d.results ?? []); })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [picking, query, productionId]);

  async function link(wikiId: string) {
    setBusy(true);
    try {
      await fetch(api, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId, wikiId }),
      });
      setPicking(false); setQuery("");
      load();
    } finally { setBusy(false); }
  }

  async function unlink(wikiId: string) {
    setBusy(true);
    try {
      await fetch(`${api}?${qs}&wikiId=${wikiId}`, { method: "DELETE" });
      setRefs(prev => prev.filter(r => r.id !== wikiId || !r.manual));
      load();
    } finally { setBusy(false); }
  }

  async function createAndGo() {
    if (!createDefaultTitle || busy) return;
    setBusy(true);
    try {
      const res = await fetch(api, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId, createTitle: createDefaultTitle }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.wiki?.id) {
        onNavigate?.();
        router.push(`/production/${productionId}/wiki/${data.wiki.id}`);
      }
    } finally { setBusy(false); }
  }

  if (refs.length === 0 && !canEdit) return null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <p className="mr-1 text-xs font-semibold tracking-[0.08em] text-zinc-600 uppercase">相关 Wiki</p>
        {canEdit && (
          <>
            <button type="button" disabled={busy} onClick={() => setPicking(p => !p)}
              className="inline-flex min-h-8 items-center rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300">+ 链接</button>
            {createDefaultTitle && (
              <button type="button" disabled={busy} onClick={createAndGo}
                className="inline-flex min-h-8 items-center rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300">+ 新建文档</button>
            )}
          </>
        )}
      </div>
      {picking && (
        <div className="mb-2">
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape") { setPicking(false); setQuery(""); } }}
            placeholder="搜索文档标题…"
            className="w-full max-w-xs rounded border border-zinc-200 px-2 py-1 text-xs outline-none focus:border-zinc-400" />
          {results.length > 0 && (
            <div className="mt-1 max-w-xs rounded border border-zinc-200 bg-white shadow-sm max-h-40 overflow-y-auto">
              {results.filter(r => !refs.some(x => x.id === r.id)).map(r => (
                <button key={r.id} type="button" disabled={busy} onClick={() => link(r.id)}
                  className="block w-full truncate px-2 py-1 text-left text-xs text-zinc-600 hover:bg-zinc-50">
                  {r.title ?? "（无标题）"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {refs.map(r => (
            <span key={r.id} className="inline-flex items-center gap-1 rounded-md bg-sky-50 border border-sky-200 px-2 py-0.5 text-xs">
              <Link href={`/production/${productionId}/wiki/${r.id}`} onClick={onNavigate}
                className="text-sky-700 hover:underline">
                [[{r.title ?? "（无标题）"}]]
              </Link>
              {canEdit && r.manual && (
                <button type="button" disabled={busy} onClick={() => unlink(r.id)}
                  title="解除链接（正文里的引用不受影响）"
                  className="text-sky-300 hover:text-sky-600 leading-none">×</button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
