"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { WikiEntityRef } from "@/lib/wiki/links";
import { mentionChipView } from "@/lib/editor/mention-display";

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
  const [details, setDetails] = useState<(string | null)[]>([]);

  useEffect(() => { setRefs(initialRefs); }, [initialRefs]);

  useEffect(() => {
    if (refs.length === 0) { setLabels([]); setUrls([]); setDetails([]); return; }
    fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mentions: refs.map(r => ({
          kind: r.entityType, displayMode: null, id: r.entityId, aux: null, versionId: null,
        })),
      }),
    })
      .then(r => (r.ok ? r.json() : { labels: [], urls: [], details: [] }))
      .then(d => { setLabels(d.labels ?? []); setUrls(d.urls ?? []); setDetails(d.details ?? []); })
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
          // 解析不出来时走类别名 + 原因的降级文案，不再吐 `block:3f2a9b1c`
          // 这种内部标识符（#689，与正文里的 chip 同一份判断）。
          const view = mentionChipView(r.entityType, labels[i] ?? null, details[i]);
          const url = view.muted ? null : urls[i];
          return (
            <span key={`${r.entityType}:${r.entityId}`} title={view.title ?? undefined}
              className="inline-flex items-center gap-1 rounded-md bg-zinc-50 border border-zinc-200 px-2 py-0.5 text-xs">
              {url ? (
                <Link href={url} className="text-zinc-600 hover:underline">{view.text}</Link>
              ) : (
                <span className="text-zinc-400">{view.text}</span>
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
