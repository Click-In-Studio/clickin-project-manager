"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { WikiEntityRef } from "@/lib/wiki-db";

// wiki 侧"关联对象"面板：本文的非 wiki 出边（body mention + manual 建链合并）。
// manual 边不在正文里，没有这个面板它们在 wiki 侧不可见。标签经 mention-resolve
// 逐观看者解析（无剧本权限的观看者拿到 null → 显示占位，不泄露内容）。
export default function WikiEntityRefs({
  productionId, wikiId, refs: initialRefs, canEdit,
}: {
  productionId: string;
  wikiId: string;
  refs: WikiEntityRef[];
  canEdit: boolean;
}) {
  const [refs, setRefs] = useState(initialRefs);
  const [labels, setLabels] = useState<(string | null)[]>([]);
  const [urls, setUrls] = useState<(string | null)[]>([]);

  useEffect(() => { setRefs(initialRefs); }, [initialRefs]);

  useEffect(() => {
    if (refs.length === 0) { setLabels([]); setUrls([]); return; }
    fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mentions: refs.map(r => ({
          kind: r.entityType, displayMode: null, id: r.entityId, aux: null, versionId: null,
        })),
      }),
    })
      .then(r => (r.ok ? r.json() : { labels: [], urls: [] }))
      .then(d => { setLabels(d.labels ?? []); setUrls(d.urls ?? []); })
      .catch(() => {});
  }, [productionId, refs]);

  async function unlink(r: WikiEntityRef) {
    await fetch(
      `${BASE_PATH}/api/production/${productionId}/wiki-refs?type=${r.entityType}&id=${encodeURIComponent(r.entityId)}&wikiId=${wikiId}`,
      { method: "DELETE" },
    ).catch(() => {});
    setRefs(prev => prev.filter(x => !(x.entityType === r.entityType && x.entityId === r.entityId && x.manual)));
  }

  if (refs.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-zinc-400 mb-1.5">关联对象 {refs.length}</p>
      <div className="flex flex-wrap gap-1.5">
        {refs.map((r, i) => {
          const label = labels[i] ?? `${r.entityType}:${r.entityId.slice(0, 8)}`;
          const url = urls[i];
          return (
            <span key={`${r.entityType}:${r.entityId}`}
              className="inline-flex items-center gap-1 rounded-md bg-zinc-50 border border-zinc-200 px-2 py-0.5 text-xs">
              {url ? (
                <Link href={url} className="text-zinc-600 hover:underline">{label}</Link>
              ) : (
                <span className="text-zinc-400">{label}</span>
              )}
              {canEdit && r.manual && (
                <button type="button" onClick={() => unlink(r)}
                  title="解除链接（正文里的引用不受影响）"
                  className="text-zinc-300 hover:text-zinc-600 leading-none">×</button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
