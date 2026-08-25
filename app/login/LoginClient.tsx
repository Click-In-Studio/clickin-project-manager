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

type AuthMode = "login" | "register";

// 设备上完成过一次注册的标记。置位时机是**注册成功之后**，不是首次打开页面——
// 后者会让还没注册完的新用户一刷新就掉进登录页，而注册天然要往返好几次
// （去邮箱取验证码再回来）。
const REGISTERED_HERE_KEY = "backstage_registered_here_v1";

export default function LoginClient({ inviteOnly }: { inviteOnly?: boolean }) {
  const [mode, setMode] = useState<"idle" | "email_sent" | "loading" | "otp_loading">("idle");
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [regCode, setRegCode] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  // 渲染期不能直接读 window（SSR 与首次 hydrate 都拿不到），改由 effect 落进 state：
  // 服务端与客户端首帧都是 undefined，一致，不会 hydration mismatch。
  const [inviteToken, setInviteToken] = useState<string | undefined>(undefined);
  const [nextDest, setNextDest] = useState("/");
  useEffect(() => {
    setInviteToken(inviteTokenFromDest());
    setNextDest(loginDest());
    // OAuth 通道的注册门在回调里拒绝时，会重定向回来并把文案挂在 ?error= 上
    // （服务端文案已面向用户）。不接住的话用户只会看到一个干净的登录页。
    const e = new URLSearchParams(window.location.search).get("error");
    if (e) setError(e === "auth_failed" ? "登录失败，请重试" : e);
    // 这台设备上还没有人注册成功过 → 首次来访更可能是要注册
    try {
      if (!window.localStorage.getItem(REGISTERED_HERE_KEY)) setAuthMode("register");
    } catch { /* 隐私模式下读不到 storage：留在登录态，安全的默认 */ }
  }, []);

  function switchAuthMode(next: AuthMode) {
    setAuthMode(next);
    setError("");
  }

  // 飞书授权入口要把注册凭据带过去：它们在 initiate 那一步被收进 httpOnly cookie，
  // 跨越「跳到飞书再跳回来」这一次往返，不会编进 state 落到第三方日志里。
  // SSR 与客户端首帧都是不带参数的裸链接（state 尚未填充），两边一致，不会 mismatch。
  const feishuHref = (() => {
    const q = new URLSearchParams();
    if (regCode.trim()) q.set("reg_code", regCode.trim());
    if (inviteToken) q.set("invite_token", inviteToken);
    if (nextDest !== "/") q.set("next", nextDest);
    const qs = q.toString();
    return `/api/auth/feishu/initiate${qs ? `?${qs}` : ""}`;
  })();

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
    if (!trimmedEmail) { setError("请输入邮箱地址"); return; }
    if (authMode === "register" && !trimmedName) { setError("请输入你的姓名"); return; }

    setMode("loading");
    try {
      const res = await fetch("/api/auth/email/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          // 意图只用于把报错说准，判定仍由服务端查 identity 决定
          authIntent: authMode,
          ...(authMode === "register" && trimmedName ? { name: trimmedName } : {}),
          ...(authMode === "register" && regCode.trim() ? { registrationCode: regCode.trim() } : {}),
          ...(inviteTokenFromDest() ? { inviteToken: inviteTokenFromDest() } : {}),
        }),
      });
      if (res.ok) {
        setMode("email_sent");
      } else {
        setMode("idle");
        // 403 = 注册邀请制拒绝，服务端文案已面向用户（如「测试期间需受邀注册」）
        const data = await res.json().catch(() => null) as { error?: string } | null;
        const shown = res.status === 403 || res.status === 409 || res.status === 429;
        setError(shown ? (data?.error ?? "发送失败，请稍后重试") : "发送失败，请稍后重试");
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
        if (authMode === "register") {
          // 注册确实完成了才置位——此后这台设备默认进登录态
          try { window.localStorage.setItem(REGISTERED_HERE_KEY, "1"); } catch { /* 忽略 */ }
        }
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
        <h1 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", textAlign: "center" }}>
          后台
        </h1>

        {/* 验证码已发出时不给切模式：切换会丢掉待输入的验证码界面，而邮件里那串码
            还有 15 分钟有效期，用户却回不到输入框，只能重发一封。 */}
        {mode === "idle" || mode === "loading" ? (
          <div
            role="tablist"
            aria-label="选择登录或注册"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: 4, marginBottom: 28, borderRadius: 10, background: "var(--paper)", border: "1px solid var(--line)" }}
          >
            {(["login", "register"] as const).map(item => {
              const selected = authMode === item;
              return (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => switchAuthMode(item)}
                  style={{
                    padding: "8px 0", border: "none", borderRadius: 7,
                    background: selected ? "var(--ink)" : "transparent",
                    color: selected ? "#fff" : "var(--muted)",
                    fontSize: 13, fontWeight: 700, cursor: "pointer",
                    transition: "background-color 160ms ease, color 160ms ease",
                  }}
                >
                  {item === "login" ? "登录" : "注册"}
                </button>
              );
            })}
          </div>
        ) : <div style={{ marginBottom: 16 }} />}

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
                {mode === "otp_loading" ? "验证中…" : authMode === "login" ? "确认登录" : "确认注册"}
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
            {/* 邀请码是「注册资格」，先于「用哪种方式注册」——放在表单里会让人误以为
                只有邮箱注册要填，而飞书注册同样要过这道门（码经 initiate 收进
                oauth_ctx cookie 带过去）。提到两个入口之上，用分隔线统领。 */}
            {authMode === "register" && inviteOnly && !inviteToken && (
              <div style={{ marginBottom: 18, paddingBottom: 18, borderBottom: "1px solid var(--line)" }}>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
                  邀请码<span style={{ fontWeight: 400 }}>（邮箱已被邀请可留空）</span>
                </label>
                <input
                  type="text"
                  value={regCode}
                  onChange={e => setRegCode(e.target.value)}
                  placeholder="测试期间需受邀注册"
                  style={{ ...inp, marginBottom: 6 }}
                />
                <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                  邮箱与飞书两种注册方式都需要
                </p>
              </div>
            )}

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
              {authMode === "register" && (
                <>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>姓名</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="你的名字"
                    required
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
                {mode === "loading" ? "发送中…" : authMode === "login" ? "获取登录验证码" : "获取注册验证码"}
              </button>
            </form>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
              <span style={{ fontSize: 11, color: "var(--muted)" }}>或</span>
              <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>

            <a
              href={feishuHref}
              style={{ display: "block", textAlign: "center", borderRadius: 9, padding: "10px 0", fontSize: 13, fontWeight: 700, background: "var(--surface)", border: "1px solid var(--line)", color: "var(--ink)", textDecoration: "none" }}
            >
              {authMode === "login" ? "使用飞书登录" : "使用飞书注册"}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
