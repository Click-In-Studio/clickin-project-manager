"use client";

import { useState, useEffect, type FormEvent } from "react";

// 登录成功后的回跳目标（仅允许站内相对路径，防 open redirect）。
// 服务端没有 window：这个组件虽标了 "use client"，SSR 阶段仍会在服务端渲染一次，
// 所以必须守卫——否则渲染期一调用就是 500（页面因降级到客户端渲染而看似正常）。
export function loginDest(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

// 从邀请链接落地（/invite/<token> → /login?next=/invite/<token>）时透传 token 作
// 注册正当性——受邀者不需要额外要注册码（lib/registration-gate.ts）。
// 不另设 window 守卫：它不直接碰 window，唯一路径是上面已守卫的 loginDest()，
// SSR 时拿到 "/" 后 match 失败返回 undefined。这条由 login-ssr 测试钉住。
export function inviteTokenFromDest(): string | undefined {
  const m = loginDest().match(/^\/invite\/([0-9a-f-]{36})$/i);
  return m?.[1];
}

export default function LoginClient({ inviteOnly }: { inviteOnly?: boolean }) {
  const [mode, setMode] = useState<"idle" | "email_sent" | "loading" | "otp_loading">("idle");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [regCode, setRegCode] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  // 渲染期不能直接读 window（SSR 与首次 hydrate 都拿不到），改由 effect 落进 state：
  // 服务端与客户端首帧都是 undefined，一致，不会 hydration mismatch。
  const [inviteToken, setInviteToken] = useState<string | undefined>(undefined);
  useEffect(() => { setInviteToken(inviteTokenFromDest()); }, []);

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
    if (!trimmedEmail) { setError("请输入邮箱地址"); return; }
    if (!trimmedName) { setError("请输入你的姓名"); return; }

    setMode("loading");
    try {
      const res = await fetch("/api/auth/email/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          name: trimmedName,
          ...(regCode.trim() ? { registrationCode: regCode.trim() } : {}),
          ...(inviteTokenFromDest() ? { inviteToken: inviteTokenFromDest() } : {}),
        }),
      });
      if (res.ok) {
        setMode("email_sent");
      } else {
        setMode("idle");
        // 403 = 注册邀请制拒绝，服务端文案已面向用户（如「测试期间需受邀注册」）
        const data = await res.json().catch(() => null) as { error?: string } | null;
        setError(res.status === 403 || res.status === 429 ? (data?.error ?? "发送失败，请稍后重试") : "发送失败，请稍后重试");
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
        window.location.href = loginDest();
      } else {
        setMode("email_sent");
        setError("验证码错误或已过期");
      }
    } catch {
      setMode("email_sent");
      setError("网络错误，请重试");
    }
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
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>姓名</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="你的名字"
                required
                style={{ ...inp, marginBottom: inviteOnly && !inviteToken ? 10 : 14 }}
              />
              {inviteOnly && !inviteToken && (
                <>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
                    邀请码<span style={{ fontWeight: 400 }}>（新用户填写；邮箱已被邀请可留空）</span>
                  </label>
                  <input
                    type="text"
                    value={regCode}
                    onChange={e => setRegCode(e.target.value)}
                    placeholder="测试期间需受邀注册"
                    style={{ ...inp, marginBottom: 14 }}
                  />
                </>
              )}
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
