"use client";

import { useState, useEffect, type FormEvent } from "react";

const AUTO_LOGIN_KEY = "feishu_auto_login_attempted";

export default function LoginClient({ feishuAppId }: { feishuAppId: string }) {
  const [mode, setMode] = useState<"idle" | "email_sent" | "loading" | "otp_loading">("idle");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  // Feishu in-app auto-login
  useEffect(() => {
    const isFeishu = /Feishu|Lark/i.test(navigator.userAgent);
    if (!isFeishu) { setShowForm(true); return; }

    if (sessionStorage.getItem(AUTO_LOGIN_KEY)) {
      sessionStorage.removeItem(AUTO_LOGIN_KEY);
      setShowForm(true);
      return;
    }

    const fallback = setTimeout(() => setShowForm(true), 5000);

    const doRequest = () => {
      const tt = (window as { tt?: { requestAuthCode: (o: { appId: string; success: (r: { code: string }) => void; fail: () => void }) => void } }).tt;
      if (!tt) { setShowForm(true); return; }

      tt.requestAuthCode({
        appId: feishuAppId,
        success: async ({ code }) => {
          const controller = new AbortController();
          const fetchTimeout = setTimeout(() => controller.abort(), 8000);
          try {
            const r = await fetch("/api/auth/feishu-code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
              signal: controller.signal,
            });
            clearTimeout(fetchTimeout);
            if (r.ok) {
              sessionStorage.setItem(AUTO_LOGIN_KEY, "1");
              window.location.href = "/";
            } else {
              setShowForm(true);
            }
          } catch {
            clearTimeout(fetchTimeout);
            setShowForm(true);
          }
        },
        fail: () => setShowForm(true),
      });
    };

    const h5sdk = (window as { h5sdk?: { ready: (cb: () => void) => void } }).h5sdk;
    if (h5sdk) h5sdk.ready(doRequest); else doRequest();

    return () => clearTimeout(fallback);
  }, [feishuAppId]);

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
    if (!trimmedEmail) { setError("请输入邮箱地址"); return; }

    setMode("loading");
    try {
      const res = await fetch("/api/auth/email/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, name: trimmedName || trimmedEmail }),
      });
      if (res.ok) {
        setMode("email_sent");
      } else {
        setMode("idle");
        setError("发送失败，请稍后重试");
      }
    } catch {
      setMode("idle");
      setError("网络错误，请稍后重试");
    }
  }

  async function handleOtpSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const code = otp.trim();
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setError("请输入 6 位数字验证码");
      return;
    }
    setMode("otp_loading");
    try {
      const res = await fetch("/api/auth/email/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code }),
      });
      if (res.ok) {
        window.location.href = "/";
      } else {
        setMode("email_sent");
        setError("验证码错误或已过期");
      }
    } catch {
      setMode("email_sent");
      setError("网络错误，请重试");
    }
  }

  if (!showForm) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--paper)" }}>
        <p style={{ fontSize: 12, color: "var(--muted)" }}>正在登录…</p>
      </div>
    );
  }

  const inp: React.CSSProperties = {
    display: "block", width: "100%", boxSizing: "border-box",
    padding: "8px 12px", fontSize: 13,
    border: "1px solid var(--line)", borderRadius: 8,
    background: "var(--paper)", color: "var(--ink)",
  };

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--paper)" }}>
      <div style={{ width: 360, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: "48px 40px" }}>
        <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--stage)", textAlign: "center" }}>
          BACKSTAGE
        </p>
        <h1 style={{ margin: "0 0 32px", fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", textAlign: "center" }}>
          后台
        </h1>

        {mode === "email_sent" || mode === "otp_loading" ? (
          /* OTP entry state */
          <div>
            <p style={{ fontSize: 13, color: "var(--ink)", margin: "0 0 4px" }}>
              验证码已发送至
            </p>
            <p style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", margin: "0 0 20px", wordBreak: "break-all" }}>
              {email.trim().toLowerCase()}
            </p>

            <form onSubmit={handleOtpSubmit} style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
                6 位验证码
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={otp}
                onChange={e => { setOtp(e.target.value.replace(/\D/g, "")); setError(""); }}
                placeholder="000000"
                autoFocus
                style={{ ...inp, fontSize: 22, fontWeight: 700, letterSpacing: ".2em", textAlign: "center", marginBottom: 14 }}
              />
              {error && <p style={{ fontSize: 12, color: "#c53030", margin: "0 0 10px" }}>{error}</p>}
              <button
                type="submit"
                disabled={mode === "otp_loading"}
                style={{ display: "block", width: "100%", padding: "10px 0", fontSize: 13, fontWeight: 700, borderRadius: 9, background: "var(--ink)", color: "#fff", border: "none", cursor: mode === "otp_loading" ? "default" : "pointer", opacity: mode === "otp_loading" ? 0.6 : 1 }}
              >
                {mode === "otp_loading" ? "验证中…" : "确认登录"}
              </button>
            </form>

            <p style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", margin: "0 0 12px" }}>
              也可点击邮件中的登录链接直接完成
            </p>

            <button
              onClick={() => { setMode("idle"); setOtp(""); setError(""); }}
              style={{ display: "block", width: "100%", fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", textAlign: "center" }}
            >
              重新发送 / 更换邮箱
            </button>
          </div>
        ) : (
          /* Email entry state */
          <>
            <form onSubmit={handleEmailSubmit} style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>邮箱</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                style={{ ...inp, marginBottom: 10 }}
              />
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>姓名（选填）</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="你的名字"
                style={{ ...inp, marginBottom: 14 }}
              />
              {error && <p style={{ fontSize: 12, color: "#c53030", margin: "0 0 10px" }}>{error}</p>}
              <button
                type="submit"
                disabled={mode === "loading"}
                style={{ display: "block", width: "100%", padding: "10px 0", fontSize: 13, fontWeight: 700, borderRadius: 9, background: "var(--ink)", color: "#fff", border: "none", cursor: mode === "loading" ? "default" : "pointer", opacity: mode === "loading" ? 0.6 : 1 }}
              >
                {mode === "loading" ? "发送中…" : "获取验证码"}
              </button>
            </form>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
              <span style={{ fontSize: 11, color: "var(--muted)" }}>或</span>
              <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>

            <a
              href="/api/auth/feishu/initiate"
              style={{ display: "block", textAlign: "center", borderRadius: 9, padding: "10px 0", fontSize: 13, fontWeight: 700, background: "var(--surface)", border: "1px solid var(--line)", color: "var(--ink)", textDecoration: "none" }}
            >
              使用飞书登录
            </a>
          </>
        )}
      </div>
    </div>
  );
}
