"use client";

import { useState } from "react";
import SmartText from "@/components/SmartText";
import styles from "@/components/home.module.css";

type Announcement = {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdAt: string;
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function plainSnippet(md: string, maxLen = 140): string {
  return md
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[(.+?)\]\(.*?\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export default function ProductionAnnouncementsClient({
  productionId,
  initialAnnouncements,
}: {
  productionId: string;
  initialAnnouncements: Announcement[];
}) {
  const [expanded, setExpanded] = useState<string | null>(
    initialAnnouncements.find(a => a.isPinned)?.id ?? null
  );

  const pinned = initialAnnouncements.filter(a => a.isPinned);
  const rest = initialAnnouncements.filter(a => !a.isPinned);

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>项目公告</p>
        <h1 className={styles.pageTitle}>公告</h1>
      </div>

      {initialAnnouncements.length === 0 ? (
        <div className={styles.emptyState} style={{ paddingTop: 80 }}>
          暂无公告
          <small>管理员发布的公告将在这里显示</small>
        </div>
      ) : (
        <>
          {pinned.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <p className={styles.kicker} style={{ marginBottom: 8 }}>置顶公告</p>
              {pinned.map(a => (
                <AnnouncementCard
                  key={a.id}
                  announcement={a}
                  expanded={expanded === a.id}
                  onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
                  productionId={productionId}
                />
              ))}
            </div>
          )}

          {rest.length > 0 && (
            <div>
              {pinned.length > 0 && (
                <p className={styles.kicker} style={{ marginBottom: 8, marginTop: 16 }}>全部公告</p>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rest.map(a => (
                  <AnnouncementCard
                    key={a.id}
                    announcement={a}
                    expanded={expanded === a.id}
                    onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
                    productionId={productionId}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AnnouncementCard({
  announcement: a,
  expanded,
  onToggle,
  productionId,
}: {
  announcement: Announcement;
  expanded: boolean;
  onToggle: () => void;
  productionId: string;
}) {
  const snippet = plainSnippet(a.content);
  const hasMore = a.content.replace(/\s/g, "").length > 140;

  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1px solid ${a.isPinned ? "var(--ink)" : "var(--line)"}`,
        borderRadius: 13,
        overflow: "hidden",
        marginBottom: a.isPinned ? 10 : 0,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          width: "100%",
          padding: "18px 22px",
          border: 0,
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        {/* Meta row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {a.isPinned && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
              background: "var(--ink)", color: "#fff", letterSpacing: ".04em",
            }}>
              置顶
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{fmtDate(a.createdAt)}</span>
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)" }}>
            {expanded ? "▲" : "▼"}
          </span>
        </div>

        {/* Title */}
        <p style={{
          margin: 0,
          fontFamily: 'Georgia, "Noto Serif SC", serif',
          fontSize: "clamp(15px, 1.6vw, 18px)",
          fontWeight: 500,
          color: "var(--ink)",
          lineHeight: 1.35,
        }}>
          {a.title}
        </p>

        {/* Preview (collapsed only) */}
        {!expanded && snippet && (
          <p style={{
            margin: 0, fontSize: 12, color: "var(--muted)",
            lineHeight: 1.6,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          } as React.CSSProperties}>
            {snippet}{hasMore ? "…" : ""}
          </p>
        )}
      </button>

      {expanded && (
        <div style={{
          padding: "0 22px 22px",
          borderTop: "1px solid var(--line)",
        }}>
          {a.content ? (
            <div style={{ paddingTop: 16 }}>
              <SmartText content={a.content} markdown contentMention={{ productionId }} />
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: 13, paddingTop: 14 }}>（无内容）</p>
          )}
        </div>
      )}
    </div>
  );
}
