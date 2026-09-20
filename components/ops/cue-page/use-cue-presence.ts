"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { usePresenceHeartbeat } from "@/hooks/usePresenceHeartbeat";
import { postCuePresence } from "@/lib/ops/cue-client";
import type { CuePresence, Selection } from "./types";

function getOrCreateClientId(): string {
  const key = "presence_client_id";
  let id = sessionStorage.getItem(key);
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem(key, id); }
  return id;
}

function anonymousName(clientId: string): string {
  return "访客 " + clientId.slice(-4).toUpperCase();
}

/**
 * 在场（presence）：本端身份、名字、别人的在场表与上报节流。SSE 订阅本身留在 CuePage
 * （它同时驱动 cue 重拉），这里只交出 setPresenceMap / lastSentPresRef 给它接线。
 * 从 CuePage 主函数体原样搬出（#487 C2）。
 */
export function useCuePresence({ productionId, activeListId, selection }: {
  productionId: string;
  activeListId: string | null;
  selection: Selection;
}) {
  const [clientId] = useState<string>(() =>
    typeof window !== "undefined" ? getOrCreateClientId() : ""
  );
  const [userName, setUserName] = useState<string>(() =>
    typeof window !== "undefined"
      ? (localStorage.getItem("presence_name") || anonymousName(getOrCreateClientId()))
      : ""
  );
  const [presenceMap, setPresenceMap] = useState<Map<string, CuePresence>>(new Map());
  const lastSentPresRef = useRef("");
  const presTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 真正发出去过的最后一份载荷（去重键 lastSentPresRef 会被重连清空，不能拿它反推）
  const lastPostedRef = useRef<{ listId: string | null; cueId: string | null } | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/me`)
      .then(r => r.json())
      .then((d: { name: string | null }) => {
        if (d.name) { setUserName(d.name); localStorage.setItem("presence_name", d.name); }
      })
      .catch(() => {});
  }, []);

  const sendCuePresence = useCallback((listId: string | null, cueId: string | null) => {
    if (!clientId || !userName) return;
    const key = `${listId}|${cueId}`;
    if (lastSentPresRef.current === key) return;
    lastSentPresRef.current = key;
    if (presTimerRef.current) clearTimeout(presTimerRef.current);
    presTimerRef.current = setTimeout(() => {
      lastPostedRef.current = { listId, cueId };
      postCuePresence(productionId, { clientId, userName, listId, cueId });
    }, 200);
  }, [clientId, userName, productionId]);

  // 在场心跳（#578）：重发上一份载荷续 updatedAt；首拍由上面的选区 effect 发
  usePresenceHeartbeat(() => {
    const last = lastPostedRef.current;
    if (!last || !clientId || !userName) return;
    postCuePresence(productionId, { clientId, userName, ...last });
  });

  useEffect(() => {
    if (selection.kind === "cue") {
      sendCuePresence(activeListId, selection.cueId);
    } else {
      // Delay clearing cueId so brief transitions through "pending" (text-drag to
      // create a selection) don't immediately wipe the cue presence indicator.
      const t = setTimeout(() => sendCuePresence(activeListId, null), 1500);
      return () => clearTimeout(t);
    }
  }, [activeListId, selection, sendCuePresence]);

  const presenceForCue = useMemo(() => {
    const m = new Map<string, CuePresence[]>();
    for (const p of presenceMap.values()) {
      if (p.clientId === clientId || !p.cueId) continue;
      if (!m.has(p.cueId)) m.set(p.cueId, []);
      m.get(p.cueId)!.push(p);
    }
    return m;
  }, [presenceMap, clientId]);

  const presenceForList = useMemo(() => {
    const m = new Map<string, CuePresence[]>();
    for (const p of presenceMap.values()) {
      if (p.clientId === clientId || !p.listId) continue;
      if (!m.has(p.listId)) m.set(p.listId, []);
      m.get(p.listId)!.push(p);
    }
    return m;
  }, [presenceMap, clientId]);

  return { clientId, userName, presenceMap, setPresenceMap, lastSentPresRef, sendCuePresence, presenceForCue, presenceForList };
}
