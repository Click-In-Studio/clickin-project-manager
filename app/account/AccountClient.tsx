"use client";

import Link from "next/link";
import { useRef, useState, useEffect, type FormEvent, type ChangeEvent } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./account.module.css";
import type { NotifPref } from "@/lib/notification-prefs";

type Identity = {
  id: string;
  platformId: string;
  platformUserId: string;
  label: string | null;
  isLoginMethod: boolean;
  isPrimary: boolean;
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
  initialNotifPrefs: NotifPref[];
};

type Page = "profile" | "security" | "preferences";

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
  security: { eyebrow: "SECURITY", title: "账号安全中心", description: "管理登录账号的邮箱、飞书等身份，以及账号安全设置。" },
  preferences: { eyebrow: "PREFERENCES", title: "功能与设置", description: "调整消息提醒方式，控制各类通知的开关。" },
};

function initial(name: string) {
  return name.trim().charAt(0) || "?";
}

/** Returns the URL to use in <img src> for a given avatarUrl value from the DB. */
function resolveAvatarSrc(userId: string, avatarUrl: string | null): string | null {
  if (!avatarUrl) return null;
  // Feishu and other HTTP URLs — use directly
  if (avatarUrl.startsWith("http")) return avatarUrl;
  // R2 key stored as a relative path — route through our proxy
  return `/api/user/avatar/${userId}`;
}

export default function AccountClient({ userId, initialProfile, initialIdentities, initialNotifPrefs }: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tabParam = searchParams.get("tab");
  const [page, setPage] = useState<Page>(
    tabParam === "security" || tabParam === "preferences" ? tabParam : "profile"
  );

  // Profile state
  const [name, setName] = useState(initialProfile.name);
  const [displayName, setDisplayName] = useState(initialProfile.displayName ?? "");
  const [bio, setBio] = useState(initialProfile.bio ?? "");
  const [preferredPlatform, setPreferredPlatform] = useState(initialProfile.preferredPlatform ?? "");
  const [avatarUrl, setAvatarUrl] = useState(initialProfile.avatarUrl);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveMsgOk, setSaveMsgOk] = useState(false);

  // Avatar upload state
  const [avatarUploading, setAvatarUploading] = useState(false);

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

  // Notification prefs state
  const [notifPrefs, setNotifPrefs] = useState<NotifPref[]>(initialNotifPrefs);
  const [notifSaving, setNotifSaving] = useState<string | null>(null);
  const [notifError, setNotifError] = useState<string | null>(null);

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
          avatarUrl: avatarUrl,
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

  async function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setSaveMsg("图片不能超过 5 MB");
      setSaveMsgOk(false);
      return;
    }
    setAvatarUploading(true);
    setSaveMsg("");
    try {
      // 1. Get presigned PUT URL
      const presignRes = await fetch("/api/account/avatar/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: file.type }),
      });
      if (!presignRes.ok) throw new Error("presign failed");
      const { uploadUrl, r2Key } = await presignRes.json() as { uploadUrl: string; r2Key: string };

      // 2. Upload directly to R2
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("upload failed");

      // 3. Save the R2 key (stored as-is; proxy route serves it)
      const patchRes = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || name,
          avatarUrl: r2Key,
        }),
      });
      if (!patchRes.ok) throw new Error("profile update failed");

      // 4. Update local display via the proxy URL (cache-busted)
      setAvatarUrl(r2Key);
      setSaveMsg("✓ 头像已更新");
      setSaveMsgOk(true);
    } catch {
      setSaveMsg("头像上传失败，请重试");
      setSaveMsgOk(false);
    } finally {
      setAvatarUploading(false);
      // Reset file input so same file can be picked again
      if (fileInputRef.current) fileInputRef.current.value = "";
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

  async function handleSetPrimary(upiId: string) {
    setBindMsg("");
    try {
      const res = await fetch("/api/account/email/set-primary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upiId }),
      });
      if (res.ok) {
        setIdentities(prev => prev.map(i => i.platformId === "email" ? { ...i, isPrimary: i.id === upiId } : i));
      } else {
        setBindMsg("设置失败，请重试");
        setBindMsgOk(false);
      }
    } catch {
      setBindMsg("网络错误");
      setBindMsgOk(false);
    }
  }

  async function handleUnbindEmail(upiId: string, email: string) {
    if (!confirm(`确认解绑邮箱 ${email}？`)) return;
    setBindMsg("");
    try {
      const res = await fetch("/api/account/email/unbind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upiId }),
      });
      if (res.ok) {
        setIdentities(prev => {
          const next = prev.filter(i => i.id !== upiId);
          const hasPrimary = next.some(i => i.platformId === "email" && i.isPrimary);
          if (!hasPrimary) {
            const firstEmail = next.find(i => i.platformId === "email");
            if (firstEmail) return next.map(i => i.id === firstEmail.id ? { ...i, isPrimary: true } : i);
          }
          return next;
        });
        setBindMsg(`已解绑 ${email}`);
        setBindMsgOk(true);
      } else {
        const body = await res.json() as { error?: string };
        setBindMsg(body.error === "last login method" ? "无法解绑：这是你唯一的登录方式" : "解绑失败，请重试");
        setBindMsgOk(false);
      }
    } catch {
      setBindMsg("网络错误");
      setBindMsgOk(false);
    }
  }

  async function handleNotifToggle(type: string, enabled: boolean) {
    setNotifSaving(type);
    setNotifError(null);
    setNotifPrefs(prev => prev.map(p => p.type === type ? { ...p, externalEnabled: enabled } : p));
    try {
      const res = await fetch("/api/my/notification-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, enabled }),
      });
      if (!res.ok) throw new Error("保存失败");
    } catch {
      setNotifPrefs(prev => prev.map(p => p.type === type ? { ...p, externalEnabled: !enabled } : p));
      setNotifError("保存失败，请重试");
    } finally {
      setNotifSaving(null);
    }
  }

  const hasFeishu = identities.some(i => i.platformId === "feishu");
  const hasEmail = identities.some(i => i.platformId === "email");
  const primaryEmail = identities.find(i => i.platformId === "email" && i.isPrimary)
    ?? identities.find(i => i.platformId === "email");
  const emailIdentities = identities.filter(i => i.platformId === "email");

  const channelOptions = identities
    .filter(i => i.isLoginMethod && (i.platformId !== "email" || i.isPrimary || !identities.some(x => x.platformId === "email" && x.isPrimary)))
    .reduce<{ value: string; label: string }[]>((acc, i) => {
      if (!acc.some(o => o.value === i.platformId))
        acc.push({ value: i.platformId, label: PLATFORM_LABEL[i.platformId] ?? i.platformId });
      return acc;
    }, []);

  const dmPrefs = notifPrefs.filter(p => p.externalChannel === "dm");
  const groupPrefs = notifPrefs.filter(p => p.externalChannel === "group");

  const avatarSrc = resolveAvatarSrc(userId, avatarUrl);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.backButton}>
          <span>←</span> 返回工作区
        </Link>
        <div className={styles.brand}>
          {avatarSrc
            ? <img src={avatarSrc} alt={name} className={styles.topbarAvatar} />
            : <i>{initial(name)}</i>}
          <b>CLICK-IN</b>
          <span>个人中心</span>
        </div>
        <div className={styles.userChip}>
          <span>{name}</span>
          {avatarSrc
            ? <img src={avatarSrc} alt={name} className={styles.topbarAvatarSm} />
            : <i>{initial(name)}</i>}
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.identity}>
            {avatarSrc
              ? <img src={avatarSrc} alt={name} className={styles.identityAvatar} />
              : <span>{initial(name)}</span>}
            <p>
              <b>{name}</b>
              {primaryEmail && <small>{primaryEmail.platformUserId}</small>}
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
            <p>偏好与隐私</p>
            <button
              type="button"
              className={page === "preferences" ? styles.navActive : ""}
              onClick={() => setPage("preferences")}
            >
              <span>调</span>
              {PAGE_META.preferences.title}
            </button>
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
                    {avatarSrc
                      ? <img src={`${avatarSrc}?t=${Date.now()}`} alt={name} className={styles.avatarImg} key={avatarUrl} />
                      : <span>{initial(name)}</span>}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className={styles.avatarFileInput}
                      onChange={handleAvatarChange}
                      disabled={avatarUploading}
                    />
                    <button
                      type="button"
                      className={styles.avatarUploadButton}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={avatarUploading}
                    >
                      {avatarUploading ? "上传中…" : "更换头像"}
                    </button>
                    <small className={styles.avatarHint}>JPG、PNG 或 WebP<br />最大 5 MB</small>
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

          {/* ── 账号安全中心 ── */}
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

                {identities.filter(id => id.platformId !== "email").map(id => (
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

                {emailIdentities.map(em => (
                  <div key={em.id} className={styles.row}>
                    <span className={styles.rowIcon}>邮</span>
                    <div className={styles.rowInfo}>
                      <b>
                        邮箱
                        {em.isPrimary && (
                          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, letterSpacing: ".06em", color: "var(--stage)", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 6px" }}>主</span>
                        )}
                      </b>
                      <span>{em.platformUserId}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      {!em.isPrimary && (
                        <button type="button" className={styles.outlineButton} style={{ fontSize: 12 }}
                          onClick={() => handleSetPrimary(em.id)}>
                          设为主邮箱
                        </button>
                      )}
                      <button type="button" className={styles.outlineButton} style={{ fontSize: 12, color: "var(--muted)" }}
                        onClick={() => handleUnbindEmail(em.id, em.platformUserId)}>
                        解绑
                      </button>
                    </div>
                  </div>
                ))}

                <div className={styles.row} style={{ flexWrap: "wrap" }}>
                  <span className={styles.rowIcon}>+</span>
                  <div className={styles.rowInfo}>
                    <b>{hasEmail ? "绑定新邮箱" : "邮箱"}</b>
                    <span>{hasEmail ? "可绑定多个邮箱，均可用于登录" : "绑定后可使用邮箱验证码登录"}</span>
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
              </section>

              {bindMsg && (
                <p className={`${styles.statusMsg} ${bindMsgOk ? styles.statusOk : styles.statusErr}`}>
                  {bindMsg}
                </p>
              )}
            </>
          )}

          {/* ── 功能与设置（通知偏好） ── */}
          {page === "preferences" && (
            <>
              {notifError && (
                <div className={styles.errorBanner}>{notifError}</div>
              )}

              <section className={styles.card}>
                <div className={styles.cardTitle}>
                  <div>
                    <h2>消息提醒</h2>
                    <p>控制各类通知的外部推送方式（飞书消息 / 邮件），收件箱通知始终开启。</p>
                  </div>
                </div>

                {dmPrefs.length > 0 && (
                  <>
                    <p className={styles.prefGroupLabel}>可以关闭的通知</p>
                    <p className={styles.prefGroupHint}>以下通知默认开启，你可以选择关闭。</p>
                    {dmPrefs.map(p => (
                      <div key={p.type} className={styles.prefRow}>
                        <div className={styles.prefRowInfo}>
                          <b>{p.label}</b>
                          <span>{p.description}</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={p.externalEnabled}
                          aria-label={p.label}
                          className={`${styles.toggle} ${p.externalEnabled ? styles.toggleOn : ""}`}
                          onClick={() => handleNotifToggle(p.type, !p.externalEnabled)}
                          disabled={notifSaving === p.type}
                        >
                          <span />
                        </button>
                      </div>
                    ))}
                  </>
                )}

                {groupPrefs.length > 0 && (
                  <>
                    <p className={styles.prefGroupLabel} style={{ marginTop: 22 }}>可以额外订阅的群通知</p>
                    <p className={styles.prefGroupHint}>以下通知默认发送至群，开启后机器人也会额外私信你一份。</p>
                    {groupPrefs.map(p => (
                      <div key={p.type} className={styles.prefRow}>
                        <div className={styles.prefRowInfo}>
                          <b>{p.label}</b>
                          <span>{p.description}</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={p.externalEnabled}
                          aria-label={p.label}
                          className={`${styles.toggle} ${p.externalEnabled ? styles.toggleOn : ""}`}
                          onClick={() => handleNotifToggle(p.type, !p.externalEnabled)}
                          disabled={notifSaving === p.type}
                        >
                          <span />
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
