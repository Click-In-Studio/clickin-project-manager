"use client";

import { useEffect, useState } from "react";

/** 等待提示不替换已有对话；耗时只能提示可能网络不佳，不能据此断言原因。 */
export default function ChatLoadingNotice({ active, label }: { active: boolean; label: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setSlow(true), 8_000);
    return () => { clearTimeout(timer); setSlow(false); };
  }, [active]);
  if (!active) return null;
  return <div className="pointer-events-none absolute left-0 right-0 top-2 z-10 px-4 text-center text-xs text-zinc-500" role="status" aria-live="polite">
    {slow ? <span className="inline-block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
      加载较慢，可能网络不佳，正在继续加载…
    </span> : <span className="inline-block rounded-full border border-zinc-200 bg-white px-3 py-1 shadow-sm">{label}</span>}
  </div>;
}
