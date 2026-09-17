"use client";

import { useState, useRef, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";
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
      const presenceQuery = activeVersionId ? `?v=${encodeURIComponent(activeVersionId)}` : "";
      fetch(`${BASE_PATH}/api/script/${effectiveScriptId}/presence${presenceQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, userName, blockId }),
      }).catch(() => {});
    }, 200);
  }, [clientId, effectiveScriptId, userName, activeVersionId]);

  return {
    clientId, userName, setUserName, presenceMap, setPresenceMap,
    presenceCountRef, presenceTimerRef, presenceLayoutTimerRef, sendPresence,
  };
}
