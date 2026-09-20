"use client";

import { useState, useRef, useCallback } from "react";
import { usePresenceHeartbeat } from "@/hooks/usePresenceHeartbeat";
import { postScriptPresence } from "@/lib/script/script-client";
import { getOrCreateClientId, anonymousName } from "./presence";
import type { RemotePresence } from "./comments";

/**
 * 在场：本端 clientId / 显示名、别人的在场表、按块上报（200ms 节流 + 同值去重）。
 * SSE 订阅留在 ScriptEditor（它同时驱动 seq 同步与 leader 选举），这里交出 setPresenceMap 与
 * 三个计时 ref 给它接线；离开页面 / 卸载时主体统一清计时器。从主函数体原样搬出（#487 S7）。
 */
export function useScriptPresence({ effectiveScriptId, activeVersionId }: {
  effectiveScriptId: string;
  activeVersionId: string | null;
}) {
  const [clientId] = useState<string>(() =>
    typeof window !== "undefined" ? getOrCreateClientId() : ""
  );
  const [userName, setUserName] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const stored = localStorage.getItem("presence_name");
    return stored || anonymousName(getOrCreateClientId());
  });
  const [presenceMap, setPresenceMap] = useState<Map<string, RemotePresence>>(new Map());
  const presenceCountRef = useRef(0);
  const lastSentPresenceRef = useRef<{ versionId: string | null; blockId: string | null } | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceLayoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendPresence = useCallback((blockId: string | null) => {
    if (!clientId || !effectiveScriptId) return;
    const lastSent = lastSentPresenceRef.current;
    if (lastSent?.versionId === activeVersionId && lastSent.blockId === blockId) return;
    lastSentPresenceRef.current = { versionId: activeVersionId, blockId };
    if (presenceTimerRef.current) clearTimeout(presenceTimerRef.current);
    presenceTimerRef.current = setTimeout(() => {
      postScriptPresence(effectiveScriptId, activeVersionId, { clientId, userName, blockId });
    }, 200);
  }, [clientId, effectiveScriptId, userName, activeVersionId]);

  // 在场心跳（#578）：重发上一次上报的块，让服务端的 updatedAt 跟上。还没聚焦过块
  // （或上次上报属于别的版本）就没什么可续，保持「聚焦才入场」的原语义。
  usePresenceHeartbeat(() => {
    const last = lastSentPresenceRef.current;
    if (!last || last.versionId !== activeVersionId || !clientId || !effectiveScriptId) return;
    postScriptPresence(effectiveScriptId, activeVersionId, { clientId, userName, blockId: last.blockId });
  });

  return {
    clientId, userName, setUserName, presenceMap, setPresenceMap,
    presenceCountRef, presenceTimerRef, presenceLayoutTimerRef, sendPresence,
  };
}
