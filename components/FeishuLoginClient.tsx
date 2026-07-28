"use client";

import { useState, useEffect } from "react";

const AUTO_LOGIN_KEY = "feishu_auto_login_attempted";

export default function FeishuLoginClient({ appId, basePath }: { appId: string; basePath: string }) {
  const [showButton, setShowButton] = useState(false);

  useEffect(() => {
    const isFeishu = /Feishu|Lark/i.test(navigator.userAgent);
    if (!isFeishu) { setShowButton(true); return; }

    // If we've already tried auto-login this session and ended up back here,
    // something went wrong (e.g. redirect loop) — go straight to the button.
    if (sessionStorage.getItem(AUTO_LOGIN_KEY)) {
      sessionStorage.removeItem(AUTO_LOGIN_KEY);
      setShowButton(true);
      return;
    }

    const fallback = setTimeout(() => setShowButton(true), 5000);

    const doRequest = () => {
      const tt = (window as { tt?: { requestAuthCode: (opts: { appId: string; success: (r: { code: string }) => void; fail: () => void }) => void } }).tt;
      if (!tt) { setShowButton(true); return; }

      tt.requestAuthCode({
        appId,
        success: async ({ code }) => {
          const controller = new AbortController();
          const fetchTimeout = setTimeout(() => controller.abort(), 8000);
          try {
            const r = await fetch(`${basePath}/api/auth/feishu-code`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
              signal: controller.signal,
            });
            clearTimeout(fetchTimeout);
            if (r.ok) {
              sessionStorage.setItem(AUTO_LOGIN_KEY, "1");
              window.location.href = basePath || "/";
            } else {
              setShowButton(true);
            }
          } catch {
            clearTimeout(fetchTimeout);
            setShowButton(true);
          }
        },
        fail: () => setShowButton(true),
      });
    };

    const h5sdk = (window as { h5sdk?: { ready: (cb: () => void) => void } }).h5sdk;
    if (h5sdk) {
      h5sdk.ready(doRequest);
    } else {
      doRequest();
    }

    return () => clearTimeout(fallback);
  }, [appId, basePath]);

  if (!showButton) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--paper)" }}>
        <p style={{ fontSize: 12, color: "var(--muted)" }}>正在登录…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--paper)" }}>
      <div style={{ width: 320, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: "48px 40px", textAlign: "center" }}>
        <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--stage)" }}>
          BACKSTAGE
        </p>
        <h1 style={{ margin: "0 0 32px", fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em" }}>
          后台
        </h1>
        <a
          href={`${basePath}/api/auth/login`}
          className="block transition-opacity hover:opacity-75"
          style={{ borderRadius: 9, padding: "10px 0", fontSize: 13, fontWeight: 700, background: "var(--ink)", color: "#fff", textDecoration: "none" }}
        >
          使用飞书登录
        </a>
        <p style={{ margin: "16px 0 0", fontSize: 11, color: "var(--muted)" }}>
          请使用飞书账号登录以继续
        </p>
      </div>
    </div>
  );
}
