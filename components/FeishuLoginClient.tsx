"use client";

import { useState, useEffect } from "react";

export default function FeishuLoginClient({ appId, basePath }: { appId: string; basePath: string }) {
  const [showButton, setShowButton] = useState(false);

  useEffect(() => {
    const isFeishu = /Feishu|Lark/i.test(navigator.userAgent);
    if (!isFeishu) { setShowButton(true); return; }

    const timeout = setTimeout(() => setShowButton(true), 5000);

    const doRequest = () => {
      const tt = (window as { tt?: { requestAuthCode: (opts: { appId: string; success: (r: { code: string }) => void; fail: () => void }) => void } }).tt;
      if (!tt) { clearTimeout(timeout); setShowButton(true); return; }

      tt.requestAuthCode({
        appId,
        success: async ({ code }) => {
          try {
            const r = await fetch(`${basePath}/api/auth/feishu-code`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
            });
            if (r.ok) {
              window.location.href = basePath || "/";
            } else {
              clearTimeout(timeout);
              setShowButton(true);
            }
          } catch {
            clearTimeout(timeout);
            setShowButton(true);
          }
        },
        fail: () => { clearTimeout(timeout); setShowButton(true); },
      });
    };

    const h5sdk = (window as { h5sdk?: { ready: (cb: () => void) => void } }).h5sdk;
    if (h5sdk) {
      h5sdk.ready(doRequest);
    } else {
      doRequest();
    }

    return () => clearTimeout(timeout);
  }, [appId, basePath]);

  if (!showButton) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-100">
        <p className="text-sm text-zinc-400">正在登录...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100">
      <div className="w-80 rounded-2xl bg-white px-8 py-10 shadow-sm text-center">
        <h1 className="mb-2 text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase">
          项目管理器
        </h1>
        <p className="mb-8 text-xs text-zinc-300">请使用飞书账号登录以继续</p>
        <a
          href={`${basePath}/api/auth/login`}
          className="inline-block w-full rounded-lg bg-zinc-800 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
        >
          使用飞书登录
        </a>
      </div>
    </div>
  );
}
