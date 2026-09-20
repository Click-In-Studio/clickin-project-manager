"use client";

// 打开更新日志页即记下「看到哪版了」（#569）。"use client" 组件 SSR 仍会渲染一次，
// localStorage 只能在 useEffect 里碰（feedback_ssr_window_guard）。

import { useEffect } from "react";
import { markChangelogSeen } from "@/lib/help/changelog-seen";

export default function ChangelogSeen({ latest }: { latest: string | null }) {
  useEffect(() => {
    if (latest) markChangelogSeen(latest);
  }, [latest]);
  return null;
}
