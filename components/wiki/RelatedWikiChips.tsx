"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";

type WikiRef = { id: string; title: string | null };

// 对象侧"相关 wiki"面板：引用了该实体的 wiki 标题 chip。
// 标题级列出（§4.1）——含观看者无权阅读的文档，点击处由 wiki 页过门+申请。
// 空列表整块不渲染（多数对象没被提过，不占版面）。
export default function RelatedWikiChips({
  productionId, entityType, entityId, onNavigate,
}: {
  productionId: string;
  entityType: "scene" | "rehearsal" | "block" | "cue" | "asset";
  entityId: string;
  onNavigate?: () => void;
}) {
  const [refs, setRefs] = useState<WikiRef[]>([]);

  const load = useCallback(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/wiki-refs?type=${entityType}&id=${encodeURIComponent(entityId)}`)
      .then(r => (r.ok ? r.json() : { refs: [] }))
      .then(d => setRefs(d.refs ?? []))
      .catch(() => setRefs([]));
  }, [productionId, entityType, entityId]);

  useEffect(() => { load(); }, [load]);

  if (refs.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase mb-1.5">相关 Wiki</p>
      <div className="flex flex-wrap gap-1.5">
        {refs.map(r => (
          <Link key={r.id} href={`/production/${productionId}/wiki/${r.id}`} onClick={onNavigate}
            className="rounded-md bg-sky-50 border border-sky-200 px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-100">
            [[{r.title ?? "（无标题）"}]]
          </Link>
        ))}
      </div>
    </div>
  );
}
