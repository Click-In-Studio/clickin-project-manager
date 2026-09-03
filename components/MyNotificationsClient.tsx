"use client";

import { useState, useEffect, useCallback } from "react";
import PageHeader from "@/components/PageHeader";
import Link from "next/link";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import styles from "@/components/my-pages.module.css";
import type { UserNotification, NotificationAction } from "@/lib/inbox-db";

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  productions?: { id: string; name: string }[];
  productionId?: string;
  compact?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Three act modes, derived from existing fields — no extra DB column needed:
 *
 *   button   actions.length > 0            → acted when inline button clicked
 *   view     !actionRequired               → acted when notification is read
 *   external actionRequired && no actions  → destination page calls act API via ?notif=
 */
type ActMode = "button" | "view" | "external";

function actMode(n: UserNotification): ActMode {
  if (n.actions.length > 0) return "button";
  if (!n.actionRequired) return "view";
  return "external";
}

function isDone(n: UserNotification): boolean {
  if (n.actedAt) return true;
  const mode = actMode(n);
  if (mode === "view") return !!n.readAt;
  return false;
}

type DisplayStatus = "pending" | "read" | "done" | "expired";

function getStatus(n: UserNotification): DisplayStatus {
  if (n.expiredAt && !n.actedAt) return "expired";
  if (isDone(n)) return "done";
  if (n.readAt) return "read";
  return "pending";
}

function dotColor(n: UserNotification): string {
  const mode = actMode(n);
  const status = getStatus(n);
  if (status === "done" || status === "read") return "var(--line)";
  if (mode === "button" || mode === "external") return "var(--stage)";
  return "var(--script)";
}

/** Append ?notif=<id> to any viewHref so destination pages can optionally call act. */
function withNotifParam(href: string, notifId: string): string {
  try {
    const u = new URL(href, "http://x");
    u.searchParams.set("notif", notifId);
    return u.pathname + u.search + u.hash;
  } catch {
    return href;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400_000);

  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d >= todayStart) return `今天 ${hhmm}`;
  if (d >= yesterdayStart) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1 < 10 ? "0" : ""}${d.getMonth() + 1}-${d.getDate() < 10 ? "0" : ""}${d.getDate()} ${hhmm}`;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = "all" | "action" | "info" | "done";

const TAB_LABELS: Record<Tab, string> = {
  all: "全部",
  action: "待确认",
  info: "仅告知",
  done: "已处理",
};

function filterByTab(items: UserNotification[], tab: Tab): UserNotification[] {
  switch (tab) {
    // "全部": everything not yet done — includes read-but-unacted (external-mode) items.
    case "all":
      return items.filter((n) => !isDone(n));
    // "待确认": actionRequired and not yet acted (button + external modes).
    case "action":
      return items.filter((n) => n.actionRequired && !n.actedAt);
    // "仅告知": view-mode items not yet read.
    case "info":
      return items.filter((n) => actMode(n) === "view" && !n.readAt);
    // "已处理": anything that passes isDone.
    case "done":
      return items.filter(isDone);
    default:
      return items;
  }
}

// ─── Action button ────────────────────────────────────────────────────────────

function ActionButtons({
  notifId,
  actions,
  expired,
  onActed,
}: {
  notifId: string;
  actions: NotificationAction[];
  expired: boolean;
  onActed: (notifId: string, actionId: string) => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!actions.length) return null;

  const handleClick = async (action: NotificationAction) => {
    if (loading || expired) return;
    setLoading(action.id);
    setError(null);
    try {
      const res = await fetch(`/api/my/notifications/${notifId}/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId: action.id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "操作失败");
      }
      onActed(notifId, action.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
      {actions.map((action) => {
        const isPrimary = action.presentation === "primary_button";
        const isLoading = loading === action.id;
        return (
          <button
            key={action.id}
            onClick={() => handleClick(action)}
            disabled={!!loading || expired}
            style={{
              border: `1px solid ${isPrimary ? "var(--ink)" : "var(--line)"}`,
              background: isPrimary ? (expired ? "var(--muted)" : "var(--ink)") : "transparent",
              borderRadius: 8,
              padding: "9px 20px",
              fontSize: 13,
              fontWeight: 600,
              color: isPrimary ? "#fff" : "var(--ink)",
              cursor: loading || expired ? "not-allowed" : "pointer",
              opacity: expired ? 0.5 : isLoading ? 0.7 : 1,
              transition: "opacity 0.15s",
            }}
          >
            {isLoading ? "处理中…" : action.label}
          </button>
        );
      })}
      {expired && (
        <span style={{ fontSize: 11, color: "var(--muted)", alignSelf: "center" }}>
          此通知已被新通知覆盖
        </span>
      )}
      {error && (
        <span style={{ fontSize: 11, color: "var(--stage)", alignSelf: "center" }}>
          {error}
        </span>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MyNotificationsClient({ productions = [], productionId, compact = false }: Props) {
  const [tab, setTab] = useState<Tab>("all");
  const [items, setItems] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<UserNotification | null>(null);
  const [markingAllRead, setMarkingAllRead] = useState(false);

  // When the tab changes, deselect if the current selection falls outside the new filter.
  const handleTabChange = (t: Tab) => {
    setTab(t);
    setSelected((prev) => {
      if (!prev) return null;
      const inNewTab = filterByTab(items, t).some((n) => n.id === prev.id);
      return inNewTab ? prev : null;
    });
  };

  const prodMap = Object.fromEntries(productions.map((p) => [p.id, p.name]));

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "60" });
    if (productionId) params.set("productionId", productionId);
    const res = await fetch(`/api/my/notifications?${params}`).then((r) => r.json()) as {
      notifications?: UserNotification[];
    };
    const notifs = res.notifications ?? [];
    if (compact) {
      setItems(notifs);
      setSelected(null);
      return;
    }
    // Only auto-select and auto-read the first item visible in the initial "all" tab.
    const first = filterByTab(notifs, "all")[0] ?? null;
    const autoRead = first && !first.readAt;

    // Optimistically mark first item as read so the detail panel opens in "read" state.
    const display = autoRead
      ? notifs.map((n) => n.id === first.id ? { ...n, readAt: new Date().toISOString() } : n)
      : notifs;

    setItems(display);
    if (first && !selected) {
      setSelected(autoRead ? { ...first, readAt: new Date().toISOString() } : first);
    }

    if (autoRead) {
      fetch("/api/my/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [first.id] }),
      }).catch(() => {});
      window.dispatchEvent(new CustomEvent("notif-read", { detail: { delta: 1 } }));
    }
  }, [productionId, compact]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const markRead = useCallback(async (id: string) => {
    await fetch("/api/my/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => {});
    setItems((prev) =>
      prev.map((n) => n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)
    );
    window.dispatchEvent(new CustomEvent("notif-read", { detail: { delta: 1 } }));
  }, []);

  const handleSelect = (n: UserNotification) => {
    setSelected(n);
    if (!n.readAt) markRead(n.id);
  };

  const handleActed = (notifId: string, _actionId: string) => {
    setItems((prev) =>
      prev.map((n) =>
        n.id === notifId
          ? { ...n, actedAt: new Date().toISOString(), readAt: n.readAt ?? new Date().toISOString() }
          : n
      )
    );
    setSelected((prev) =>
      prev?.id === notifId
        ? { ...prev, actedAt: new Date().toISOString(), readAt: prev.readAt ?? new Date().toISOString() }
        : prev
    );
  };

  const handleMarkAllRead = async () => {
    setMarkingAllRead(true);
    const wasUnread = unreadUndoneCount;
    await fetch("/api/my/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(productionId ? { productionId } : {}),
    }).catch(() => {});
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? now })));
    if (wasUnread > 0) {
      window.dispatchEvent(new CustomEvent("notif-read", { detail: { delta: wasUnread } }));
    }
    setMarkingAllRead(false);
  };

  const filtered = filterByTab(items, tab);
  const pendingActionCount = items.filter((n) => n.actionRequired && !n.actedAt).length;
  // Items not yet done and not yet read — used for badge decrement in "全部已读".
  const unreadUndoneCount = items.filter((n) => !isDone(n) && !n.readAt).length;

  function renderDetail(n: UserNotification) {
    const status = getStatus(n);
    const mode = actMode(n);
    const prodName = n.productionId ? (prodMap[n.productionId] ?? n.productionId) : null;
    const viewLink = n.viewHref ? withNotifParam(n.viewHref, n.id) : null;

    return (
      <div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            {/* Category tag */}
            {status === "pending" && mode === "button" && (
              <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                background: "var(--warn-soft)", color: "var(--warn)" }}>
                待确认
              </span>
            )}
            {status === "pending" && mode === "external" && (
              <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                background: "var(--warn-soft)", color: "var(--warn)" }}>
                待处理
              </span>
            )}
            {mode === "view" && !isDone(n) && (
              <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                background: "var(--surface-2)", color: "var(--script)" }}>
                告知
              </span>
            )}
            {status === "expired" && (
              <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                background: "var(--surface-2)", color: "var(--muted)" }}>
                已失效
              </span>
            )}
            {isDone(n) && (
              <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                background: "var(--success-soft)", color: "var(--success)" }}>
                {n.actedAt ? "已处理" : "已读"}
              </span>
            )}
          </div>
          <h2 style={{
            margin: "0 0 6px",
            fontFamily: 'Georgia, "Noto Serif SC", serif',
            fontSize: "clamp(18px, 2vw, 24px)", fontWeight: 500, color: "var(--ink)",
            lineHeight: 1.3,
          }}>
            {n.title}
          </h2>
          <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
            {[prodName, formatTime(n.createdAt)].filter(Boolean).join(" · ")}
          </p>
        </div>

        {n.body && (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 20, marginBottom: 24 }}>
            <WikiMarkdown
              content={n.body}
              productionId={n.productionId ?? undefined}
              className={styles.bodyText}
            />
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          {viewLink && (
            <Link
              href={viewLink}
              style={{
                fontSize: 13, color: "var(--script)", textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              查看详情 →
            </Link>
          )}

          {n.actionRequired && !n.actedAt && n.actions.length > 0 && (
            <ActionButtons
              notifId={n.id}
              actions={n.actions}
              expired={!!n.expiredAt}
              onActed={handleActed}
            />
          )}
        </div>
      </div>
    );
  }

  function renderListItem(n: UserNotification, isSelected: boolean, onClick: () => void) {
    const prodName = n.productionId ? (prodMap[n.productionId] ?? null) : null;
    const status = getStatus(n);
    return (
      <button
        key={n.id}
        onClick={onClick}
        style={{
          border: "1px solid " + (isSelected ? "var(--ink)" : "transparent"),
          borderRadius: 10, padding: "12px 14px",
          background: isSelected ? "var(--ink)" : "transparent",
          cursor: "pointer", textAlign: "left", width: "100%",
          display: "flex", alignItems: "flex-start", gap: 10,
        }}
      >
        <span style={{
          width: 7, height: 7, borderRadius: "50%", flexShrink: 0, marginTop: 5,
          background: isSelected ? "rgba(255,255,255,.4)" : dotColor(n),
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            margin: "0 0 3px", fontSize: 13, fontWeight: status === "pending" ? 700 : 500,
            color: isSelected ? "#fff" : "var(--ink)",
            display: "-webkit-box", WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: 1.35,
          }}>
            {n.title}
          </p>
          <p style={{ margin: 0, fontSize: 11, color: isSelected ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
            {prodName ?? n.kind}
          </p>
        </div>
        <span style={{
          fontSize: 10, color: isSelected ? "rgba(255,255,255,.5)" : "var(--muted)",
          whiteSpace: "nowrap", flexShrink: 0, marginTop: 2,
        }}>
          {formatTime(n.createdAt)}
        </span>
      </button>
    );
  }

  if (compact) {
    // Keep the expanded item rendered even after markRead moves it out of the
    // current tab — an info notification is done the moment it's read, and the
    // inline detail would otherwise unmount mid-read.
    const filteredIds = new Set(filtered.map((n) => n.id));
    const visible = items.filter((n) => filteredIds.has(n.id) || n.id === selected?.id);
    return (
      <section className={styles.notificationColumn} aria-labelledby="personal-notifications-heading">
        <header className={styles.notificationColumnHeader}>
          <div>
            <p className={styles.notificationColumnKicker}>PERSONAL</p>
            <h2 id="personal-notifications-heading">个人通知</h2>
            <p>{unreadUndoneCount > 0 ? `${unreadUndoneCount} 条未读` : "通知均已阅读"}</p>
          </div>
          <button
            type="button"
            className={styles.markAllReadButton}
            onClick={handleMarkAllRead}
            disabled={markingAllRead || unreadUndoneCount === 0}
          >
            {markingAllRead ? "处理中…" : "一键已读"}
          </button>
        </header>

        <div className={styles.compactTabBar} role="tablist" aria-label="个人通知筛选">
          {(["all", "action", "info", "done"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => handleTabChange(t)}>
              {TAB_LABELS[t]}
              {t === "action" && pendingActionCount > 0 && <span>{pendingActionCount}</span>}
            </button>
          ))}
        </div>

        <div className={styles.notificationColumnScroll}>
          {loading ? (
            <div className={styles.emptyState}>加载中…</div>
          ) : visible.length === 0 ? (
            <div className={styles.emptyState}>
              暂无{tab !== "all" ? TAB_LABELS[tab] : ""}通知
              <small>新的个人通知将在这里显示</small>
            </div>
          ) : (
            visible.map((n) => {
              const isExpanded = selected?.id === n.id;
              const status = getStatus(n);
              const mode = actMode(n);
              const prodName = n.productionId ? (prodMap[n.productionId] ?? null) : null;
              const preview = n.body
                ?.replace(/^#+\s+/gm, "")
                .replace(/\*\*(.+?)\*\*/g, "$1")
                .replace(/\n+/g, " ")
                .trim();

              return (
                <article
                  key={n.id}
                  className={`${styles.compactFeedItem} ${isExpanded ? styles.compactFeedItemExpanded : ""}`}
                >
                  <button
                    className={styles.compactFeedButton}
                    onClick={() => {
                      setSelected(isExpanded ? null : n);
                      if (!n.readAt && !isExpanded) markRead(n.id);
                    }}
                  >
                    <div className={styles.compactFeedMeta}>
                      <span className={!n.readAt ? styles.compactUnreadDotStage : styles.compactReadDot} />
                      {status === "pending" && (mode === "button" || mode === "external") && (
                        <span className={styles.compactTagWarm}>{mode === "button" ? "待确认" : "待处理"}</span>
                      )}
                      {status === "expired" && <span className={styles.compactTag}>已失效</span>}
                      {isDone(n) && <span className={styles.compactTagSuccess}>{n.actedAt ? "已处理" : "已读"}</span>}
                      <time>{formatTime(n.createdAt)}</time>
                    </div>
                    <h3>{n.title}</h3>
                    <p className={styles.compactFeedSource}>{prodName ?? n.kind}</p>
                    {!isExpanded && preview && <p>{preview}</p>}
                  </button>

                  {isExpanded && (
                    <div className={styles.compactFeedDetail}>
                      {n.body && (
                        <WikiMarkdown
                          content={n.body}
                          productionId={n.productionId ?? undefined}
                          className={styles.bodyText}
                        />
                      )}
                      <div className={styles.compactFeedActions}>
                        {n.viewHref && (
                          <Link href={withNotifParam(n.viewHref, n.id)}>查看详情 →</Link>
                        )}
                        {n.actionRequired && !n.actedAt && n.actions.length > 0 && (
                          <ActionButtons
                            notifId={n.id}
                            actions={n.actions}
                            expired={!!n.expiredAt}
                            onActed={handleActed}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>
    );
  }

  return (
    <div className={productionId ? undefined : styles.workspace} style={productionId ? { padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" } : undefined}>
      {productionId ? (
        <PageHeader eyebrow="Notifications" title="通知提醒" side="stage" />
      ) : (
        <div className={styles.pageHeader}>
          <p className={styles.eyebrow}>Platform · 通知</p>
          <h1 className={styles.pageTitle}>通知提醒</h1>
        </div>
      )}

      {/* ── 摘要统计（原型 notificationSummary；Action Bar 横幅省略——与页头重复）── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(items.filter((n) => actMode(n) === "view" && !n.readAt).length), "未读", "仅告知或需要查看"],
          [String(items.filter((n) => n.actionRequired && !n.actedAt).length), "待确认 / 处理", "关键变化与行动"],
          [String(items.filter(isDone).length), "已处理", "确认与完成的记录"],
        ].map(([num, label, hint]) => (
          <div key={label} style={{
            minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13,
            background: "var(--surface)",
          }}>
            <span style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28, color: "var(--ink)" }}>{num}</span>
            <p style={{ margin: 0, display: "flex", flexDirection: "column" }}>
              <b style={{ fontSize: 11, color: "var(--ink)" }}>{label}</b>
              <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 9 }}>{hint}</small>
            </p>
          </div>
        ))}
      </div>

      {/* ── Panel（原型排版）：内部维持现有 tab + 分栏 ── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column" }}>
      <div className={styles.tabBar} role="tablist" aria-label="通知筛选" style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {(["all", "action", "info", "done"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => handleTabChange(t)}>
            {TAB_LABELS[t]}
            {t === "action" && pendingActionCount > 0 && (
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 16, height: 16, borderRadius: "50%",
                background: tab === "action" ? "rgba(255,255,255,.25)" : "var(--stage)",
                color: "#fff", fontSize: 9, fontWeight: 700, marginLeft: 5,
              }}>
                {pendingActionCount}
              </span>
            )}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {unreadUndoneCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            disabled={markingAllRead}
            style={{
              fontSize: 11, color: "var(--muted)", cursor: "pointer",
              border: "none", background: "transparent", padding: "4px 8px",
              opacity: markingAllRead ? 0.5 : 1,
            }}
          >
            全部标为已读
          </button>
        )}
      </div>

      {/* ── Mobile: accordion list ── */}
      <div className={styles.mobileOnly}>
        {loading ? (
          <div className={styles.emptyState}>加载中…</div>
        ) : filtered.length === 0 ? (
          <div className={styles.emptyState}>
            暂无{tab !== "all" ? TAB_LABELS[tab] : ""}通知
            <small>新的通知将在这里显示</small>
          </div>
        ) : (
          <div className={styles.mobileCardList}>
            {filtered.map((n) => {
              const isExpanded = selected?.id === n.id;
              const status = getStatus(n);
              const prodName = n.productionId ? (prodMap[n.productionId] ?? null) : null;
              return (
                <div
                  key={n.id}
                  className={styles.mobileCard}
                  style={{ borderLeftColor: dotColor(n) }}
                >
                  <button
                    className={styles.mobileCardBtn}
                    onClick={() => {
                      setSelected(isExpanded ? null : n);
                      if (!n.readAt && !isExpanded) markRead(n.id);
                    }}
                  >
                    <div className={styles.mobileCardHeader}>
                      <span className={styles.mobileCardProduction}>
                        {prodName ?? n.kind}
                      </span>
                      <span className={styles.mobileCardTime}>{formatTime(n.createdAt)}</span>
                    </div>
                    <p className={`${styles.mobileCardTitle} ${isExpanded ? "" : styles.mobileCardTitleClamp}`}>
                      {n.title}
                    </p>
                  </button>

                  {isExpanded && (
                    <div className={styles.mobileCardDetail}>
                      <div className={styles.mobileCardMeta}>
                        {(() => {
                          const mode = actMode(n);
                          const done = isDone(n);
                          if (status === "expired") return (
                            <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: "var(--surface-2)", color: "var(--muted)" }}>已失效</span>
                          );
                          if (done) return (
                            <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: "var(--success-soft)", color: "var(--success)" }}>{n.actedAt ? "已处理" : "已读"}</span>
                          );
                          if (mode === "button" || mode === "external") return (
                            <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: "var(--warn-soft)", color: "var(--warn)" }}>{mode === "button" ? "待确认" : "待处理"}</span>
                          );
                          return (
                            <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: "var(--surface-2)", color: "var(--script)" }}>告知</span>
                          );
                        })()}
                      </div>

                      {n.body && (
                        <WikiMarkdown
                          content={n.body}
                          productionId={n.productionId ?? undefined}
                          className={styles.bodyText}
                        />
                      )}

                      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
                        {n.viewHref && (
                          <Link
                            href={withNotifParam(n.viewHref, n.id)}
                            style={{ fontSize: 13, color: "var(--script)", textDecoration: "underline", textUnderlineOffset: 3 }}
                          >
                            查看详情 →
                          </Link>
                        )}
                        {n.actionRequired && !n.actedAt && n.actions.length > 0 && (
                          <ActionButtons
                            notifId={n.id}
                            actions={n.actions}
                            expired={!!n.expiredAt}
                            onActed={handleActed}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Desktop: master-detail split ── */}
      <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
        <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
          {/* Left: list */}
          <div className={`${styles.splitPane} ${styles.splitList}`}>
            {loading ? (
              <div className={styles.emptyState} style={{ paddingTop: 40 }}>加载中…</div>
            ) : filtered.length === 0 ? (
              <div className={styles.emptyState} style={{ paddingTop: 40, paddingRight: 16 }}>
                暂无{tab !== "all" ? TAB_LABELS[tab] : ""}通知
                <small>新的通知将在这里显示</small>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 16 }}>
                {filtered.map((n) =>
                  renderListItem(n, selected?.id === n.id, () => handleSelect(n))
                )}
              </div>
            )}
          </div>

          {/* Right: detail */}
          <div className={`${styles.splitPane} ${styles.splitDetail}`}>
            {!selected ? (
              <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                选择左侧通知查看详情
              </div>
            ) : (
              renderDetail(selected)
            )}
          </div>
        </div>
      </div>
      </section>
    </div>
  );
}
