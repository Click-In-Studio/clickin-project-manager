"use client";

import { useState, useEffect, useRef } from "react";
import { extractProductionId } from "./route";
import type { ShellSession } from "./types";

/**
 * 侧栏徽标（未读通知 / 待办任务 / 未读报告 / cue 告警）。
 * 从 AppShell 主函数体原样搬出（#487 A2），签名就是原来那几个 state + 它们的刷新 effect。
 */
export function useShellBadges({
  session,
  pathname,
  initialUnreadCount,
  initialPendingTasks,
  initialUnreadReports,
}: {
  session: ShellSession | null;
  pathname: string;
  initialUnreadCount: number;
  initialPendingTasks: number;
  initialUnreadReports: number;
}) {
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [pendingTasks, setPendingTasks] = useState(initialPendingTasks);
  const [unreadReports, setUnreadReports] = useState(initialUnreadReports);
  const [cueWarnings, setCueWarnings] = useState(0);

  // Track current productionId via ref so fetchCounts always uses the latest value
  // without needing to be in the effect dependency array.
  const currentProductionIdRef = useRef<string | null>(extractProductionId(pathname));
  currentProductionIdRef.current = extractProductionId(pathname);

  // Expose fetchCounts via ref so the production-switch effect can call it.
  const fetchCountsRef = useRef<(() => void) | null>(null);

  // When the user switches to a different production, clear badges immediately so
  // stale counts from the previous context don't briefly show.
  const prevProductionIdRef = useRef<string | null>(currentProductionIdRef.current);
  useEffect(() => {
    const pid = extractProductionId(pathname);
    if (pid !== prevProductionIdRef.current) {
      prevProductionIdRef.current = pid;
      if (session) {
        setUnreadCount(0);
        setPendingTasks(0);
        setUnreadReports(0);
        setCueWarnings(0);
        fetchCountsRef.current?.();
      }
    }
  }, [pathname, session]);

  // Keep badge fresh:
  // 1. Re-fetch when tab becomes visible (like GitHub) or window regains focus.
  // 2. Listen for custom 'notif-read' events dispatched by the notifications page
  //    so the badge decrements instantly without waiting for the next poll.
  // 3. 60 s poll as a backstop for long-lived focused tabs.
  useEffect(() => {
    if (!session) return;

    const fetchCounts = () => {
      const pid = currentProductionIdRef.current;
      const url = pid
        ? `/api/my/pending-counts?productionId=${encodeURIComponent(pid)}`
        : "/api/my/pending-counts";
      return fetch(url)
        .then((r) => r.json())
        .then((d: { notifications?: number; tasks?: number; reports?: number; cueWarnings?: number }) => {
          if (typeof d.notifications === "number") setUnreadCount(d.notifications);
          if (typeof d.tasks === "number") setPendingTasks(d.tasks);
          if (typeof d.reports === "number") setUnreadReports(d.reports);
          if (typeof d.cueWarnings === "number") setCueWarnings(d.cueWarnings);
        })
        .catch(() => {});
    };

    fetchCountsRef.current = fetchCounts;

    const onVisible = () => { if (!document.hidden) fetchCounts(); };
    const onRead = (e: Event) => {
      const delta = (e as CustomEvent<{ delta?: number }>).detail?.delta;
      if (typeof delta === "number") {
        setUnreadCount((c) => Math.max(0, c - delta));
      } else {
        fetchCounts();
      }
    };

    fetchCounts();
    const id = setInterval(fetchCounts, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("notif-read", onRead);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("notif-read", onRead);
    };
  }, [session]);

  return { unreadCount, pendingTasks, unreadReports, cueWarnings };
}
