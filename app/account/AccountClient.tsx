"use client";

import { useState, useEffect, type FormEvent } from "react";
import { useSearchParams, useRouter } from "next/navigation";

type Identity = {
  id: string;
  platformId: string;
  platformUserId: string;
  label: string | null;
  isLoginMethod: boolean;
};

type Props = {
  initialProfile: { name: string; avatarUrl: string | null };
  initialIdentities: Identity[];
};

const PLATFORM_LABEL: Record<string, string> = {
  feishu: "飞书",
  email: "邮箱",
};

export default function AccountClient({ initialProfile, initialIdentities }: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [tab, setTab] = useState<"profile" | "security">("profile");

  // Profile state
  const [name, setName] = useState(initialProfile.name);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Security state
  const [identities, setIdentities] = useState<Identity[]>(initialIdentities);
  const [bindEmail, setBindEmail] = useState("");
  const [bindingEmail, setBindingEmail] = useState(false);
  const [bindMsg, setBindMsg] = useState("");

  // Merge state
  const [pendingMerge, setPendingMerge] = useState<string | null>(null);
  const [mergePlatform, setMergePlatform] = useState<string>("");
  const [merging, setMerging] = useState(false);

  // Read URL params on mount
  useEffect(() => {
    const bound = searchParams.get("bound");
    const bindError = searchParams.get("bind_error");
    const pm = searchParams.get("pending_merge");
    const mp = searchParams.get("merge_platform") ?? "";

    if (bound) {
      setTab("security");
      setBindMsg(`${PLATFORM_LABEL[bound] ?? bound} 绑定成功`);
      router.replace("/account", { scroll: false });
    } else if (bindError) {
      setTab("security");
      setBindMsg(bindError === "expired" ? "绑定链接已过期，请重新发送" : "绑定失败，请重试");
      router.replace("/account", { scroll: false });
    } else if (pm) {
      setTab("security");
      setPendingMerge(pm);
      setMergePlatform(mp);
      router.replace("/account", { scroll: false });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      setSaveMsg(res.ok ? "已保存" : "保存失败");
    } catch {
      setSaveMsg("网络错误");
    } finally {
      setSaving(false);
    }
  }

  async function handleBindEmail(e: FormEvent) {
    e.preventDefault();
    const email = bindEmail.trim().toLowerCase();
    if (!email) return;
    setBindingEmail(true);
    setBindMsg("");
    try {
      const res = await fetch("/api/account/bind/email/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setBindMsg(res.ok ? `绑定链接已发送至 ${email}，请检查收件箱` : "发送失败，请重试");
      if (res.ok) setBindEmail("");
    } catch {
      setBindMsg("网络错误");
    } finally {
      setBindingEmail(false);
    }
  }

  async function handleMerge() {
    if (!pendingMerge) return;
    setMerging(true);
    try {
      const res = await fetch("/api/account/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pendingMerge }),
      });
      if (res.ok) {
        setPendingMerge(null);
        setBindMsg("账号合并成功");
        // Reload identities
        const r2 = await fetch("/api/account/identities");
        if (r2.ok) setIdentities(await r2.json() as Identity[]);
      } else {
        setBindMsg("合并失败，请重试");
      }
    } catch {
      setBindMsg("网络错误");
    } finally {
      setMerging(false);
    }
  }

  const hasFeishu = identities.some(i => i.platformId === "feishu");
  const hasEmail = identities.some(i => i.platformId === "email");

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "32px 20px" }}>
      <h1 style={{ fontSize: 18, fontWeight: 800, color: "var(--ink)", margin: "0 0 24px", letterSpacing: "-.01em" }}>
        个人中心
      </h1>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--line)", paddingBottom: 0 }}>
        {(["profile", "security"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: tab === t ? 700 : 400,
              color: tab === t ? "var(--ink)" : "var(--muted)",
              background: "none",
              border: "none",
              borderBottom: tab === t ? "2px solid var(--ink)" : "2px solid transparent",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {t === "profile" ? "个人信息" : "登录方式"}
          </button>
        ))}
      </div>

      {/* Profile tab */}
      {tab === "profile" && (
        <form onSubmit={handleSaveProfile} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={labelStyle}>姓名</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button type="submit" disabled={saving} style={primaryBtn}>
              {saving ? "保存中…" : "保存"}
            </button>
            {saveMsg && <span style={{ fontSize: 12, color: saveMsg === "已保存" ? "#2f855a" : "#c53030" }}>{saveMsg}</span>}
          </div>
        </form>
      )}

      {/* Security tab */}
      {tab === "security" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

          {/* Merge warning */}
          {pendingMerge && (
            <div style={{ background: "#fff3cd", border: "1px solid #f6c23e", borderRadius: 10, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: "#856404" }}>
                ⚠ 该{PLATFORM_LABEL[mergePlatform] ?? mergePlatform}账号已存在
              </p>
              <p style={{ margin: "0 0 14px", fontSize: 12, color: "#856404" }}>
                这个{PLATFORM_LABEL[mergePlatform] ?? mergePlatform}身份已经绑定了另一个账号。点击"合并账号"将另一个账号的数据合并到当前账号，合并后无法撤销。
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleMerge}
                  disabled={merging}
                  style={{ padding: "7px 16px", fontSize: 12, fontWeight: 700, borderRadius: 7, background: "#c53030", color: "#fff", border: "none", cursor: merging ? "default" : "pointer", opacity: merging ? 0.7 : 1 }}
                >
                  {merging ? "合并中…" : "合并账号"}
                </button>
                <button
                  onClick={() => setPendingMerge(null)}
                  style={{ padding: "7px 16px", fontSize: 12, borderRadius: 7, background: "none", border: "1px solid var(--line)", cursor: "pointer", color: "var(--muted)" }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {bindMsg && (
            <p style={{ fontSize: 12, color: bindMsg.includes("成功") ? "#2f855a" : "#c53030", margin: 0 }}>{bindMsg}</p>
          )}

          {/* Current identities */}
          <div>
            <p style={{ ...labelStyle, marginBottom: 10 }}>已绑定的登录方式</p>
            {identities.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--muted)" }}>暂无</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {identities.map(id => (
                  <div
                    key={id.id}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "var(--paper)", borderRadius: 9, border: "1px solid var(--line)" }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--stage)", minWidth: 32 }}>
                      {PLATFORM_LABEL[id.platformId] ?? id.platformId}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {id.platformUserId}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Bind Feishu */}
          {!hasFeishu && (
            <div>
              <p style={{ ...labelStyle, marginBottom: 8 }}>绑定飞书</p>
              <a
                href="/api/account/bind/feishu/initiate"
                style={{ display: "inline-block", padding: "8px 16px", fontSize: 13, fontWeight: 700, borderRadius: 9, background: "var(--ink)", color: "#fff", textDecoration: "none" }}
              >
                使用飞书授权绑定
              </a>
            </div>
          )}

          {/* Bind Email */}
          {!hasEmail && (
            <div>
              <p style={{ ...labelStyle, marginBottom: 8 }}>绑定邮箱</p>
              <form onSubmit={handleBindEmail} style={{ display: "flex", gap: 8 }}>
                <input
                  type="email"
                  value={bindEmail}
                  onChange={e => setBindEmail(e.target.value)}
                  placeholder="输入邮箱地址"
                  required
                  style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
                />
                <button type="submit" disabled={bindingEmail} style={{ ...primaryBtn, whiteSpace: "nowrap" }}>
                  {bindingEmail ? "发送中…" : "发送绑定链接"}
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--muted)",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 12px",
  fontSize: 13,
  border: "1px solid var(--line)",
  borderRadius: 8,
  background: "var(--paper)",
  color: "var(--ink)",
  marginBottom: 0,
};

const primaryBtn: React.CSSProperties = {
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 9,
  background: "var(--ink)",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
