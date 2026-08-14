"use client";

import { useState, useRef, useEffect } from "react";
import SmartText from "@/components/SmartText";
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

export default function ProductionAnnouncementsClient({ productionId, productionName, initialAnnouncements, initialReadIds }: Props) {
  const [readIds, setReadIds] = useState<Set<string>>(new Set(initialReadIds));
  const [selected, setSelected] = useState<Announcement | null>(
    initialAnnouncements[0] ?? null
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
            <SmartText
              content={a.content}
              markdown
              contentMention={{ productionId }}
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
    initialAnnouncements[0]?.id ?? null
  );

  function handleMobileToggle(a: Announcement) {
    const next = mobileExpanded === a.id ? null : a.id;
    setMobileExpanded(next);
    if (next === a.id && !readIds.has(a.id)) doMarkRead(a.id);
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Header — 与「我的工作」统一 */}
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>{productionName}</p>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1 className={styles.pageTitle}>项目公告</h1>
          {unreadCount > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
              background: "var(--script)", color: "#fff",
            }}>
              {unreadCount} 条未读
            </span>
          )}
        </div>
      </div>

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
                          <SmartText content={a.content} markdown contentMention={{ productionId }} className={styles.bodyText} />
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
          <div className={styles.desktopOnly}>
            <div className={styles.splitLayout}>
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
    </div>
  );
}
