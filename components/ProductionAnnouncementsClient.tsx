"use client";

import { useState, useRef, useEffect } from "react";
import PageHeader from "@/components/PageHeader";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import styles from "@/components/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";

type Announcement = {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdAt: string;
};

type Props = {
  productionId: string;
  productionName: string;
  initialAnnouncements: Announcement[];
  initialReadIds: string[];
  compact?: boolean;
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400_000);
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d >= todayStart) return `今天 ${hhmm}`;
  if (d >= yesterdayStart) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function ProductionAnnouncementsClient({ productionId, productionName, initialAnnouncements, initialReadIds, compact = false }: Props) {
  const [readIds, setReadIds] = useState<Set<string>>(new Set(initialReadIds));
  const [selected, setSelected] = useState<Announcement | null>(
    compact ? null : (initialAnnouncements[0] ?? null)
  );
  const markingRef = useRef<Set<string>>(new Set());

  function doMarkRead(id: string) {
    if (markingRef.current.has(id)) return;
    markingRef.current.add(id);
    setReadIds(prev => { const s = new Set(prev); s.add(id); return s; });
    fetch(`${BASE_PATH}/api/production/${productionId}/announcements/${id}/read`, {
      method: "POST",
    }).catch(() => {});
  }

  // Auto-mark the initially selected announcement on mount
  useEffect(() => {
    if (compact) return;
    const first = initialAnnouncements[0];
    if (first && !readIds.has(first.id)) doMarkRead(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSelect(a: Announcement) {
    setSelected(a);
    if (!readIds.has(a.id)) doMarkRead(a.id);
  }

  const unreadCount = initialAnnouncements.filter(a => !readIds.has(a.id)).length;

  function renderDetail(a: Announcement) {
    return (
      <div>
        {/* Meta */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          {a.isPinned && (
            <span style={{
              padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
              background: "var(--ink)", color: "#fff",
            }}>
              置顶
            </span>
          )}
          {readIds.has(a.id) ? (
            <span style={{
              padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
              background: "var(--success-soft)", color: "var(--success)",
            }}>
              已读
            </span>
          ) : (
            <span style={{
              padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
              background: "var(--surface-2)", color: "var(--script)",
            }}>
              未读
            </span>
          )}
        </div>

        {/* Title */}
        <h2 style={{
          margin: "0 0 6px",
          fontFamily: 'Georgia, "Noto Serif SC", serif',
          fontSize: "clamp(18px, 2vw, 24px)", fontWeight: 500, color: "var(--ink)",
          lineHeight: 1.3,
        }}>
          {a.title}
        </h2>
        <p style={{ margin: "0 0 20px", fontSize: 11, color: "var(--muted)" }}>
          {fmtDate(a.createdAt)}
        </p>

        {/* Content */}
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 20 }}>
          {a.content ? (
            <WikiMarkdown
              content={a.content}
              productionId={productionId}
              className={styles.bodyText}
            />
          ) : (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>（无内容）</p>
          )}
        </div>
      </div>
    );
  }

  function renderListItem(a: Announcement) {
    const isSelected = selected?.id === a.id;
    const isUnread = !readIds.has(a.id);
    return (
      <button
        key={a.id}
        onClick={() => handleSelect(a)}
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
          background: isSelected
            ? "rgba(255,255,255,.4)"
            : isUnread ? "var(--script)" : "var(--line)",
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            margin: "0 0 3px", fontSize: 13, fontWeight: isUnread ? 700 : 500,
            color: isSelected ? "#fff" : "var(--ink)",
            display: "-webkit-box", WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: 1.35,
          }}>
            {a.isPinned && (
              <span style={{
                display: "inline-block", fontSize: 9, fontWeight: 700,
                padding: "1px 5px", borderRadius: 4,
                background: isSelected ? "rgba(255,255,255,.2)" : "var(--surface-2)",
                color: isSelected ? "white" : "var(--ink)",
                marginRight: 6, verticalAlign: "middle",
              }}>
                置顶
              </span>
            )}
            {a.title}
          </p>
          <p style={{ margin: 0, fontSize: 11, color: isSelected ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
            {fmtDate(a.createdAt)}
          </p>
        </div>
      </button>
    );
  }

  // Mobile: accordion
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(
    compact ? null : (initialAnnouncements[0]?.id ?? null)
  );

  function handleMobileToggle(a: Announcement) {
    const next = mobileExpanded === a.id ? null : a.id;
    setMobileExpanded(next);
    if (next === a.id && !readIds.has(a.id)) doMarkRead(a.id);
  }

  if (compact) {
    return (
      <section className={styles.notificationColumn} aria-labelledby="project-announcements-heading">
        <header className={styles.notificationColumnHeader}>
          <div>
            <p className={styles.notificationColumnKicker}>PROJECT</p>
            <h2 id="project-announcements-heading">项目公告</h2>
            <p>{unreadCount > 0 ? `${unreadCount} 条未读` : "公告均已阅读"}</p>
          </div>
          <span className={styles.notificationColumnCount}>{initialAnnouncements.length}</span>
        </header>

        <div className={styles.notificationColumnScroll}>
          {initialAnnouncements.length === 0 ? (
            <div className={styles.emptyState}>
              暂无项目公告
              <small>管理员发布的公告将在这里显示</small>
            </div>
          ) : (
            initialAnnouncements.map((a) => {
              const isExpanded = mobileExpanded === a.id;
              const isUnread = !readIds.has(a.id);
              const preview = a.content
                .replace(/^#+\s+/gm, "")
                .replace(/\*\*(.+?)\*\*/g, "$1")
                .replace(/\n+/g, " ")
                .trim();

              return (
                <article
                  key={a.id}
                  className={`${styles.compactFeedItem} ${isExpanded ? styles.compactFeedItemExpanded : ""}`}
                >
                  <button className={styles.compactFeedButton} onClick={() => handleMobileToggle(a)}>
                    <div className={styles.compactFeedMeta}>
                      <span className={isUnread ? styles.compactUnreadDot : styles.compactReadDot} />
                      {a.isPinned && <span className={styles.compactTagDark}>置顶</span>}
                      {isUnread && <span className={styles.compactTag}>未读</span>}
                      <time>{fmtDate(a.createdAt)}</time>
                    </div>
                    <h3>{a.title}</h3>
                    {!isExpanded && preview && <p>{preview}</p>}
                  </button>
                  {isExpanded && (
                    <div className={styles.compactFeedDetail}>
                      {a.content ? (
                        <WikiMarkdown content={a.content} productionId={productionId} className={styles.bodyText} />
                      ) : (
                        <p style={{ color: "var(--muted)", fontSize: 13 }}>（无内容）</p>
                      )}
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
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Header（v3 统一页头） */}
      <PageHeader
        eyebrow={productionName}
        title={
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 12 }}>
            项目公告
            {unreadCount > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                background: "var(--script)", color: "#fff", fontFamily: "system-ui, sans-serif",
              }}>
                {unreadCount} 条未读
              </span>
            )}
          </span>
        }
        side="stage"
      />

      {/* ── 摘要统计（统一语汇）── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(initialAnnouncements.length), "全部公告", "本项目累计"],
          [String(unreadCount), "未读", "待你查看"],
          [String(initialAnnouncements.filter(a => a.isPinned).length), "置顶", "重点公告"],
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

      {/* ── Panel（统一定高）── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column" }}>
      {initialAnnouncements.length === 0 ? (
        <div className={styles.emptyState} style={{ paddingTop: 60 }}>
          暂无公告
          <small>管理员发布的公告将在这里显示</small>
        </div>
      ) : (
        <>
          {/* ── Mobile: accordion ── */}
          <div className={styles.mobileOnly}>
            <div className={styles.mobileCardList}>
              {initialAnnouncements.map(a => {
                const isExpanded = mobileExpanded === a.id;
                const isUnread = !readIds.has(a.id);
                return (
                  <div
                    key={a.id}
                    className={`${styles.mobileCard} ${isUnread ? styles.info : ""}`}
                  >
                    <button
                      className={styles.mobileCardBtn}
                      onClick={() => handleMobileToggle(a)}
                    >
                      <div className={styles.mobileCardHeader}>
                        <span className={styles.mobileCardProduction}>
                          {a.isPinned ? "📌 置顶" : "公告"}
                        </span>
                        <span className={styles.mobileCardTime}>{fmtDate(a.createdAt)}</span>
                      </div>
                      <p className={`${styles.mobileCardTitle} ${isExpanded ? "" : styles.mobileCardTitleClamp}`}>
                        {a.title}
                      </p>
                      {!isExpanded && a.content && (
                        <p className={styles.mobileCardPreview}>
                          {a.content.replace(/^#+\s+/gm, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\n+/g, " ").trim().slice(0, 120)}
                        </p>
                      )}
                    </button>
                    {isExpanded && (
                      <div className={styles.mobileCardDetail}>
                        {a.content ? (
                          <WikiMarkdown content={a.content} productionId={productionId} className={styles.bodyText} />
                        ) : (
                          <p style={{ color: "var(--muted)", fontSize: 13 }}>（无内容）</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Desktop: master-detail ── */}
          <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
            <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
              {/* Left: list */}
              <div className={`${styles.splitPane} ${styles.splitList}`}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 16 }}>
                  {initialAnnouncements.map(a => renderListItem(a))}
                </div>
              </div>

              {/* Right: detail */}
              <div className={`${styles.splitPane} ${styles.splitDetail}`}>
                {selected ? renderDetail(selected) : (
                  <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                    选择左侧公告查看详情
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
      </section>
    </div>
  );
}
