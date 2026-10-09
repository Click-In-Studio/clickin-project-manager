"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";

type RecentVisit = { wikiId: string; title: string | null; lastViewedAt: string };
type State = { kind: "loading" } | { kind: "error"; unavailable: boolean } | { kind: "ready"; recent: RecentVisit[] };

// 复用已定稿的 wiki-personal 契约；缺字段不能当成真实空历史。
function readRecent(data: unknown): RecentVisit[] {
  const recent = (data as { recent?: unknown } | null)?.recent;
  if (!Array.isArray(recent) || recent.some(item => !item
    || typeof item.wikiId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.wikiId)
    || (typeof item.title !== "string" && item.title !== null)
    || typeof item.lastViewedAt !== "string" || !Number.isFinite(Date.parse(item.lastViewedAt)))) {
    throw new Error("最近访问响应不符合契约");
  }
  // 服务端按当前阅读权限过滤、倒序返回至多 20 条；前端只展示前 5 个不同文档。
  const seen = new Set<string>();
  return recent.filter(item => {
    if (seen.has(item.wikiId)) return false;
    seen.add(item.wikiId);
    return true;
  }).slice(0, 5);
}

export default function WikiRecentVisits({ productionId, currentWikiId, onNavigate }: {
  productionId: string;
  /** 仅由通过正文阅读门的页面传入真实 wiki id，软链接已在服务端归一。 */
  currentWikiId?: string;
  onNavigate: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [visitFailed, setVisitFailed] = useState(false);
  const [visitRevision, setVisitRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    // 客户端挂载意味着正文已实际呈现；RSC 预取不会执行此 effect。
    if (currentWikiId) {
      void fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${currentWikiId}/visit`, {
        method: "POST", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      }).then(response => {
        if (active) setVisitFailed(!response.ok);
      }).catch(() => { if (active) setVisitFailed(true); })
        .finally(() => { if (active) setVisitRevision(value => value + 1); });
    }
    return () => { active = false; controller.abort(); };
  }, [productionId, currentWikiId]);

  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    async function load() {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setState({ kind: "loading" });
      try {
        const response = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki-personal`, {
          cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        if (!active || signal.aborted) return;
        if (!response.ok) {
          setState({ kind: "error", unavailable: response.status === 404 || response.status === 501 });
          return;
        }
        const recent = readRecent(await response.json());
        if (active && !signal.aborted) setState({ kind: "ready", recent });
      } catch {
        if (active && !signal.aborted) setState({ kind: "error", unavailable: false });
      }
    }
    void load();
    // 访问 POST 完成（成功或失败）后重新读取服务端真相，不在本地虚构首项。
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => { active = false; controller?.abort(); window.removeEventListener("focus", refresh); };
  }, [productionId, currentWikiId, retry, visitRevision]);

  return (
    <section aria-label="最近访问" className="shrink-0 border-b border-zinc-200 px-2.5 py-1.5">
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}
        className="flex min-h-9 w-full items-center gap-1.5 rounded-md px-1 text-left text-xs font-semibold text-zinc-500 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-zinc-500">
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>最近访问
      </button>
      {!collapsed && <div aria-live="polite" aria-busy={state.kind === "loading"}>
        {state.kind === "loading" && <p className="px-1 py-2 text-xs text-zinc-400">加载中…</p>}
        {state.kind === "error" && <div className="px-1 py-1 text-xs text-zinc-500">
          <p>{state.unavailable ? "最近访问暂不可用" : "最近访问加载失败"}</p>
          <button type="button" onClick={() => setRetry(value => value + 1)} className="min-h-9 rounded px-2 underline focus-visible:outline-2">重试</button>
        </div>}
        {state.kind === "ready" && (state.recent.length === 0
          ? <p className="px-1 py-2 text-xs text-zinc-400">暂无最近访问记录</p>
          : <ul className="max-h-[30dvh] overflow-y-auto">
            {state.recent.map(item => <li key={item.wikiId}>
              <Link href={`/production/${productionId}/wiki/${item.wikiId}`} prefetch={false} onClick={onNavigate}
                aria-current={item.wikiId === currentWikiId ? "page" : undefined} title={item.title || "（无标题）"}
                className={`flex min-h-9 min-w-0 items-center rounded-md px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-zinc-500 ${item.wikiId === currentWikiId ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"}`}>
                <span className="min-w-0 truncate">{item.title || "（无标题）"}</span>
              </Link>
            </li>)}
          </ul>)}
        {visitFailed && <p className="px-1 py-1 text-xs text-zinc-500">本次访问未能记录，阅读不受影响</p>}
      </div>}
    </section>
  );
}
