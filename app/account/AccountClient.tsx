"use client";

import Link from "next/link";
import { useState, useEffect, type FormEvent } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./account.module.css";

type Identity = {
  id: string;
  platformId: string;
  platformUserId: string;
  label: string | null;
  isLoginMethod: boolean;
  displayName: string | null;
  avatarUrl: string | null;
};

type AccountSummary = {
  userId: string;
  name: string | null;
  identities: { platformId: string; label: string | null }[];
  productionCount: number;
};

type MergePreview = {
  userIdA: string;
  userIdB: string;
  summaryA: AccountSummary | null;
  summaryB: AccountSummary | null;
  canMerge: boolean;
  sharedProductions: { id: string; name: string }[];
};

type Props = {
  userId: string;
  initialProfile: {
    name: string;
    displayName: string | null;
    bio: string | null;
    preferredPlatform: string | null;
    avatarUrl: string | null;
  };
  initialIdentities: Identity[];
};

type Page = "profile" | "security";

const PLATFORM_LABEL: Record<string, string> = {
  feishu: "飞书",
  email: "邮箱",
};

const PLATFORM_ICON: Record<string, string> = {
  feishu: "书",
  email: "邮",
};

const PAGE_META: Record<Page, { eyebrow: string; title: string; description: string }> = {
  profile: { eyebrow: "ACCOUNT", title: "个人信息", description: "管理你的基础资料，以及在项目协作中向其他成员展示的信息。" },
  security: { eyebrow: "SECURITY", title: "登录方式", description: "管理登录账号的邮箱、飞书等身份，以及账号安全设置。" },
};

function initial(name: string) {
  return name.trim().charAt(0) || "?";
}

export default function AccountClient({ userId, initialProfile, initialIdentities }: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [page, setPage] = useState<Page>("profile");

  // Profile state
  const [name, setName] = useState(initialProfile.name);
  const [displayName, setDisplayName] = useState(initialProfile.displayName ?? "");
  const [bio, setBio] = useState(initialProfile.bio ?? "");
  const [preferredPlatform, setPreferredPlatform] = useState(initialProfile.preferredPlatform ?? "");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveMsgOk, setSaveMsgOk] = useState(false);

  // Security state
  const [identities, setIdentities] = useState<Identity[]>(initialIdentities);
  const [bindEmail, setBindEmail] = useState("");
  const [bindingEmail, setBindingEmail] = useState(false);
  const [bindMsg, setBindMsg] = useState("");
  const [bindMsgOk, setBindMsgOk] = useState(false);

  // Merge state
  const [pendingMerge, setPendingMerge] = useState<string | null>(null);
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const [mergeKeepUserId, setMergeKeepUserId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    const bound = searchParams.get("bound");
    const bindError = searchParams.get("bind_error");
    const pm = searchParams.get("pending_merge");

    if (bound) {
      setPage("security");
      setBindMsg(`${PLATFORM_LABEL[bound] ?? bound} 绑定成功`);
      setBindMsgOk(true);
      router.replace("/account", { scroll: false });
    } else if (bindError) {
      setPage("security");
      setBindMsg(bindError === "expired" ? "绑定链接已过期，请重新发送" : "绑定失败，请重试");
      setBindMsgOk(false);
      router.replace("/account", { scroll: false });
    } else if (pm) {
      setPage("security");
      setPendingMerge(pm);
      router.replace("/account", { scroll: false });
      setMergePreviewLoading(true);
      fetch(`/api/account/merge-preview?token=${encodeURIComponent(pm)}`)
        .then(r => r.json())
        .then((data: MergePreview) => setMergePreview(data))
        .catch(() => setBindMsg("无法加载合并信息，请刷新重试"))
        .finally(() => setMergePreviewLoading(false));
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
        body: JSON.stringify({
          name: name.trim(),
          displayName: displayName.trim() || null,
          bio: bio.trim() || null,
          preferredPlatform: preferredPlatform || null,
        }),
      });
      setSaveMsgOk(res.ok);
      setSaveMsg(res.ok ? "✓ 已保存" : "保存失败，请重试");
    } catch {
      setSaveMsgOk(false);
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
      const ok = res.ok;
      setBindMsg(ok ? `绑定链接已发送至 ${email}，请检查收件箱` : "发送失败，请重试");
      setBindMsgOk(ok);
      if (ok) setBindEmail("");
    } catch {
      setBindMsg("网络错误");
      setBindMsgOk(false);
    } finally {
      setBindingEmail(false);
    }
  }

  async function handleMerge(keepUserId: string) {
    if (!pendingMerge) return;
    setMerging(true);
    try {
      const res = await fetch("/api/account/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pendingMerge, keepUserId }),
      });
      if (res.ok) {
        if (keepUserId !== userId) {
          // Session user was deleted — need full reload to pick up new session
          window.location.href = "/account";
          return;
        }
        setPendingMerge(null);
        setMergePreview(null);
        setMergeKeepUserId(null);
        setBindMsg("账号合并成功");
        setBindMsgOk(true);
        const r2 = await fetch("/api/account/identities");
        if (r2.ok) setIdentities(await r2.json() as Identity[]);
      } else {
        const body = await res.json() as { error?: string };
        setBindMsg(body.error ?? "合并失败，请重试");
        setBindMsgOk(false);
      }
    } catch {
      setBindMsg("网络错误");
      setBindMsgOk(false);
    } finally {
      setMerging(false);
    }
  }

  const hasFeishu = identities.some(i => i.platformId === "feishu");
  const hasEmail = identities.some(i => i.platformId === "email");
  const emailIdentity = identities.find(i => i.platformId === "email");

  // Options for 主要通道 — only bound platforms
  const channelOptions = identities
    .filter(i => i.isLoginMethod)
    .map(i => ({ value: i.platformId, label: PLATFORM_LABEL[i.platformId] ?? i.platformId }));

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.backButton}>
          <span>←</span> 返回工作区
        </Link>
        <div className={styles.brand}>
          <i>{initial(name)}</i>
          <b>CLICK-IN</b>
          <span>个人中心</span>
        </div>
        <div className={styles.userChip}>
          <span>{name}</span>
          <i>{initial(name)}</i>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.identity}>
            <span>{initial(name)}</span>
            <p>
              <b>{name}</b>
              {emailIdentity && <small>{emailIdentity.platformUserId}</small>}
            </p>
          </div>
          <nav className={styles.sidebarNav} aria-label="个人中心导航">
            <p>账户</p>
            {(["profile", "security"] as const).map(id => (
              <button
                key={id}
                type="button"
                className={page === id ? styles.navActive : ""}
                onClick={() => setPage(id)}
              >
                <span>{id === "profile" ? "人" : "盾"}</span>
                {PAGE_META[id].title}
              </button>
            ))}
          </nav>
        </aside>

        <main className={styles.main}>
          <div className={styles.pageHeader}>
            <p>{PAGE_META[page].eyebrow}</p>
            <h1>{PAGE_META[page].title}</h1>
            <span>{PAGE_META[page].description}</span>
          </div>

          {/* ── 个人信息 ── */}
          {page === "profile" && (
            <form onSubmit={handleSaveProfile}>
              <section className={styles.card}>
                <div className={styles.cardTitle}>
                  <div>
                    <h2>公开资料</h2>
                    <p>这些信息会出现在项目成员、任务和 Event 中。</p>
                  </div>
                </div>
                <div className={styles.profileEditor}>
                  <div className={styles.formGrid}>
                    <label>
                      <span>真名</span>
                      <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="你的真实姓名"
                        required
                      />
                    </label>
                    <label>
                      <span>显示名</span>
                      <input
                        type="text"
                        value={displayName}
                        onChange={e => setDisplayName(e.target.value)}
                        placeholder="如：林淼 · 舞监"
                      />
                    </label>
                    <label className={styles.fullField}>
                      <span>简介</span>
                      <textarea
                        value={bio}
                        onChange={e => setBio(e.target.value)}
                        placeholder="制作人 / 舞台监督，负责跨部门排练协调与现场执行。"
                        rows={3}
                      />
                    </label>
                    {channelOptions.length > 0 && (
                      <label>
                        <span>主要通道</span>
                        <select
                          value={preferredPlatform}
                          onChange={e => setPreferredPlatform(e.target.value)}
                        >
                          <option value="">自动</option>
                          {channelOptions.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className={styles.avatarEditor}>
                    <span>{initial(name)}</span>
                    <p className={styles.avatarLabel}>头像功能<br />即将上线</p>
                  </div>
                </div>
              </section>

              <div className={styles.actions}>
                {saveMsg && (
                  <span className={saveMsgOk ? styles.statusOk : styles.statusErr}>
                    {saveMsg}
                  </span>
                )}
                <button type="submit" className={styles.primaryButton} disabled={saving}>
                  {saving ? "保存中…" : "保存更改"}
                </button>
              </div>
            </form>
          )}

          {/* ── 登录方式 ── */}
          {page === "security" && (
            <>
              {pendingMerge && (
                <div className={styles.mergeWarning}>
                  <p>⚠ 发现账号冲突</p>
                  <p>你绑定的身份已关联到另一个账号。你可以将两个账号合并为一个，选择保留哪个账号的资料，另一个账号的登录方式和项目成员记录将转移过来。合并后无法撤销。</p>
                  {mergePreviewLoading && (
                    <p style={{ fontSize: 12, color: "var(--muted)" }}>正在加载账号信息…</p>
                  )}
                  {mergePreview && !mergePreview.canMerge && (
                    <div className={styles.mergeBlocked}>
                      <b>无法合并：两个账号同属以下项目</b>
                      <ul>
                        {mergePreview.sharedProductions.map(p => (
                          <li key={p.id}>{p.name}</li>
                        ))}
                      </ul>
                      <p>请先在各项目中确认两个账号的职位设置，再由项目管理员移除其中一个账号，然后重试合并。</p>
                    </div>
                  )}
                  {mergePreview?.canMerge && (
                    <>
                      <div className={styles.mergeAccounts}>
                        {([
                          { id: mergePreview.userIdA, summary: mergePreview.summaryA },
                          { id: mergePreview.userIdB, summary: mergePreview.summaryB },
                        ] as const).map(({ id, summary }) => (
                          <div
                            key={id}
                            className={`${styles.mergeAccountCard} ${mergeKeepUserId === id ? styles.mergeAccountCardSelected : ""}`}
                          >
                            <div className={styles.mergeAccountLabel}>
                              {id === userId ? "此账号（当前登录）" : "对方账号"}
                            </div>
                            <div className={styles.mergeAccountName}>
                              {summary?.name ?? "未命名账号"}
                            </div>
                            <div className={styles.mergeAccountMeta}>
                              {summary?.identities.map((idn, i) => (
                                <span key={i}>
                                  {PLATFORM_LABEL[idn.platformId] ?? idn.platformId}
                                  {idn.label ? `：${idn.label}` : ""}
                                </span>
                              ))}
                              <span>{summary?.productionCount ?? 0} 个项目</span>
                            </div>
                            <button
                              type="button"
                              className={mergeKeepUserId === id ? styles.primaryButton : styles.outlineButton}
                              onClick={() => setMergeKeepUserId(id)}
                              disabled={merging}
                            >
                              {mergeKeepUserId === id ? "✓ 选择保留此账号" : "保留此账号"}
                            </button>
                          </div>
                        ))}
                      </div>
                      {mergeKeepUserId && (
                        <div className={styles.mergeButtons}>
                          <button
                            type="button"
                            className={styles.mergeConfirmButton}
                            onClick={() => handleMerge(mergeKeepUserId)}
                            disabled={merging}
                          >
                            {merging ? "合并中…" : "确认合并"}
                          </button>
                          <button
                            type="button"
                            className={styles.mergeCancelButton}
                            onClick={() => { setPendingMerge(null); setMergePreview(null); setMergeKeepUserId(null); }}
                          >
                            取消
                          </button>
                        </div>
                      )}
                      {!mergeKeepUserId && (
                        <button
                          type="button"
                          className={styles.mergeCancelButton}
                          onClick={() => { setPendingMerge(null); setMergePreview(null); }}
                        >
                          取消
                        </button>
                      )}
                    </>
                  )}
                  {!mergePreviewLoading && !mergePreview && (
                    <button
                      type="button"
                      className={styles.mergeCancelButton}
                      onClick={() => setPendingMerge(null)}
                    >
                      取消
                    </button>
                  )}
                </div>
              )}

              <section className={styles.card}>
                <div className={styles.cardTitle}>
                  <div>
                    <h2>已绑定的登录方式</h2>
                    <p>使用以下身份均可登录你的账号。</p>
                  </div>
                </div>

                {identities.length === 0 && (
                  <p style={{ fontSize: 11, color: "var(--muted)", margin: 0 }}>暂无绑定的登录方式</p>
                )}

                {identities.map(id => (
                  <div key={id.id} className={styles.row}>
                    <span className={styles.rowIcon}>
                      {PLATFORM_ICON[id.platformId] ?? id.platformId.slice(0, 1)}
                    </span>
                    <div className={styles.rowInfo}>
                      <b>{PLATFORM_LABEL[id.platformId] ?? id.platformId}</b>
                      <span>
                        {id.platformId === "feishu"
                          ? (id.displayName ?? "已绑定")
                          : id.platformUserId}
                      </span>
                    </div>
                  </div>
                ))}

                {!hasFeishu && (
                  <div className={styles.row}>
                    <span className={styles.rowIcon}>书</span>
                    <div className={styles.rowInfo}>
                      <b>飞书</b>
                      <span>绑定后可使用飞书账号登录</span>
                    </div>
                    <a href="/api/account/bind/feishu/initiate" className={styles.outlineButton}>
                      绑定飞书
                    </a>
                  </div>
                )}

                {!hasEmail && (
                  <div className={styles.row} style={{ flexWrap: "wrap" }}>
                    <span className={styles.rowIcon}>邮</span>
                    <div className={styles.rowInfo}>
                      <b>邮箱</b>
                      <span>绑定后可使用邮箱验证码登录</span>
                    </div>
                    <form onSubmit={handleBindEmail} className={styles.bindForm} style={{ margin: 0 }}>
                      <input
                        type="email"
                        value={bindEmail}
                        onChange={e => setBindEmail(e.target.value)}
                        placeholder="输入邮箱地址"
                        required
                        className={styles.bindInput}
                      />
                      <button type="submit" className={styles.outlineButton} disabled={bindingEmail}>
                        {bindingEmail ? "发送中…" : "发送链接"}
                      </button>
                    </form>
                  </div>
                )}
              </section>

              {bindMsg && (
                <p className={`${styles.statusMsg} ${bindMsgOk ? styles.statusOk : styles.statusErr}`}>
                  {bindMsg}
                </p>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
