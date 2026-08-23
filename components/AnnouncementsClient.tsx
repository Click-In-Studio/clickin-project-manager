"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import SmartText from "@/components/SmartText";
import styles from "@/components/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";
import type { CrossProjectAnnouncement, CueWarningEntry } from "@/lib/db";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function plainSnippet(md: string, maxLen = 100): string {
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

type Tab = "announcements" | "risks";

type Props = {
  announcements: CrossProjectAnnouncement[];
  cueWarnings: CueWarningEntry[];
  initialReadIds: string[];
};

export default function AnnouncementsClient({ announcements, cueWarnings, initialReadIds }: Props) {
  const [tab, setTab] = useState<Tab>("announcements");
  const [selected, setSelected] = useState<CrossProjectAnnouncement | null>(announcements[0] ?? null);
  const [expandedId, setExpandedId] = useState<string | null>(announcements[0]?.id ?? null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set(initialReadIds));
  const markingRef = useRef<Set<string>>(new Set());

  // Auto-mark first announcement as read on mount
  useEffect(() => {
    const first = announcements[0];
    if (first) doMarkRead(first.id, first.productionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function doMarkRead(announcementId: string, productionId: string) {
    if (readIds.has(announcementId) || markingRef.current.has(announcementId)) return;
    markingRef.current.add(announcementId);
    setReadIds(prev => { const s = new Set(prev); s.add(announcementId); return s; });
    fetch(`${BASE_PATH}/api/production/${productionId}/announcements/${announcementId}/read`, {
      method: "POST",
    }).catch(() => {});
  }

  function handleSelect(item: CrossProjectAnnouncement) {
    setSelected(item);
    doMarkRead(item.id, item.productionId);
  }

  function handleMobileToggle(item: CrossProjectAnnouncement) {
    const next = expandedId === item.id ? null : item.id;
    setExpandedId(next);
    if (next === item.id) doMarkRead(item.id, item.productionId);
  }

  const orphaned = cueWarnings.filter(c => c.warningType === "orphaned");
  const adjusted = cueWarnings.filter(c => c.warningType === "adjusted");

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>Platform · 公告</p>
        <h1 className={styles.pageTitle}>公告与风险提醒</h1>
      </div>

      {/* ── 摘要统计（通知提醒同款语汇）── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(announcements.length), "项目公告", "各项目汇总"],
          [String(announcements.filter(a => a.isPinned).length), "置顶", "重点公告"],
          [String(cueWarnings.length), "风险提示", "Cue 锚定异常"],
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
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className={styles.tabBar}>
        <button aria-selected={tab === "announcements"} onClick={() => setTab("announcements")}>
          项目公告{announcements.length > 0 ? ` (${announcements.length})` : ""}
        </button>
        <button aria-selected={tab === "risks"} onClick={() => setTab("risks")}>
          风险提示{cueWarnings.length > 0 ? ` (${cueWarnings.length})` : ""}
        </button>
      </div>

      {/* ── 公告 tab ── */}
      {tab === "announcements" && (
        <>
          {/* Mobile: accordion */}
          <div className={styles.mobileOnly}>
            {announcements.length === 0 ? (
              <div className={styles.emptyState}>
                暂无公告
                <small>各项目尚未发布公告</small>
              </div>
            ) : (
              <div className={styles.mobileCardList}>
                {announcements.map(item => {
                  const isExpanded = expandedId === item.id;
                  return (
                    <div key={item.id} className={`${styles.mobileCard} ${styles.info}`}>
                      <button
                        onClick={() => handleMobileToggle(item)}
                        className={styles.mobileCardBtn}
                      >
                        <div className={styles.mobileCardHeader}>
                          <span className={styles.mobileCardProduction}>
                            {item.isPinned ? "📌 " : ""}{item.productionName}
                          </span>
                          <span className={styles.mobileCardTime}>{fmtDate(item.createdAt)}</span>
                        </div>
                        <p className={`${styles.mobileCardTitle} ${isExpanded ? "" : styles.mobileCardTitleClamp}`}>
                          {item.title}
                        </p>
                        {!isExpanded && (
                          <p className={styles.mobileCardPreview}>{plainSnippet(item.content)}</p>
                        )}
                      </button>
                      {isExpanded && (
                        <div className={styles.mobileCardDetail}>
                          <SmartText
                            content={item.content}
                            markdown
                            contentMention={{ productionId: item.productionId }}
                            className={styles.bodyText}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Desktop: master-detail split */}
          <div className={styles.splitLayout} style={{ flex: 1, minHeight: 0, height: "auto" }}>
            <div className={`${styles.splitPane} ${styles.splitList}`}>
              {announcements.length === 0 ? (
                <div className={styles.emptyState}>
                  暂无公告
                  <small>各项目尚未发布公告</small>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingRight: 16 }}>
                  {announcements.map(item => {
                    const isSelected = selected?.id === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleSelect(item)}
                        style={{
                          border: `1px solid ${isSelected ? "var(--ink)" : item.isPinned ? "#aebbb5" : "var(--line)"}`,
                          borderRadius: 10,
                          padding: "14px 16px",
                          background: isSelected ? "var(--ink)" : item.isPinned ? "#e2e7e4" : "var(--surface)",
                          boxShadow: !isSelected && item.isPinned ? "inset 4px 0 0 #536a62" : "none",
                          cursor: "pointer",
                          textAlign: "left",
                          width: "100%",
                          transition: "border-color .1s, background .1s, box-shadow .1s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                          {item.isPinned && <span style={{ fontSize: 10, flexShrink: 0 }}>📌</span>}
                          <span style={{
                            flex: 1, fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
                            textTransform: "uppercase",
                            color: isSelected ? "rgba(255,255,255,.6)" : "var(--muted)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>
                            {item.productionName}
                          </span>
                          <span style={{
                            fontSize: 10,
                            color: isSelected ? "rgba(255,255,255,.5)" : "var(--muted)",
                            whiteSpace: "nowrap", flexShrink: 0,
                          }}>
                            {fmtDate(item.createdAt)}
                          </span>
                        </div>
                        <p style={{
                          margin: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.35,
                          color: isSelected ? "#fff" : "var(--ink)",
                          display: "-webkit-box", WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical", overflow: "hidden",
                        }}>
                          {item.title}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={`${styles.splitPane} ${styles.splitDetail}`}>
              {!selected ? (
                <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                  选择左侧公告查看详情
                </div>
              ) : (
                <div>
                  <div style={{ marginBottom: 22 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                      {selected.isPinned && (
                        <span className={`${styles.badge} ${styles.badgeBlue}`}>📌 置顶</span>
                      )}
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{selected.productionName}</span>
                    </div>
                    <h2 style={{
                      margin: "0 0 8px", fontFamily: 'Georgia, "Noto Serif SC", serif',
                      fontSize: "clamp(20px, 2vw, 28px)", fontWeight: 500, color: "var(--ink)",
                      lineHeight: 1.25,
                    }}>
                      {selected.title}
                    </h2>
                    <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                      {fmtDate(selected.createdAt)}
                    </p>
                  </div>
                  <div style={{ borderTop: "1px solid var(--line)", paddingTop: 22 }}>
                    <SmartText
                      content={selected.content}
                      markdown
                      contentMention={{ productionId: selected.productionId }}
                      className={styles.bodyText}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── 风险提示 tab ── */}
      {tab === "risks" && (
        <div className={styles.contentStack} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {cueWarnings.length === 0 ? (
            <div className={styles.emptyState}>
              当前没有风险提示
              <small>所有 Cue 锚定状态正常</small>
            </div>
          ) : (
            <>
              {adjusted.length > 0 && (
                <section className={styles.panel}>
                  <div className={styles.panelHeading}>
                    <div>
                      <p className={styles.kicker}>Cue Warning · 位置偏移</p>
                      <h2>位置已自动调整</h2>
                    </div>
                    <span className={`${styles.badge} ${styles.badgeAmber}`}>{adjusted.length}</span>
                  </div>
                  <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
                    以下 Cue 所锚定的块内正文已被修改，系统依据 LCS 算法自动重新计算了起止位置。建议人工核对是否仍准确对应原意图。
                  </p>
                  <CueWarningList items={adjusted} />
                </section>
              )}

              {orphaned.length > 0 && (
                <section className={styles.panel}>
                  <div className={styles.panelHeading}>
                    <div>
                      <p className={styles.kicker}>Cue Warning · 锚点丢失</p>
                      <h2>锚点块已删除</h2>
                    </div>
                    <span className={`${styles.badge} ${styles.badgeRed}`}>{orphaned.length}</span>
                  </div>
                  <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
                    以下 Cue 原锚定的块已从剧本中移除，系统已将端点自动迁移至相邻间隙。请核实 Cue 当前位置是否仍符合预期。
                  </p>
                  <CueWarningList items={orphaned} />
                </section>
              )}
            </>
          )}
        </div>
      )}
      </section>
    </div>
  );
}

function CueWarningList({ items }: { items: CueWarningEntry[] }) {
  const byProduction = new Map<string, { name: string; items: CueWarningEntry[] }>();
  for (const item of items) {
    if (!byProduction.has(item.productionId)) {
      byProduction.set(item.productionId, { name: item.productionName, items: [] });
    }
    byProduction.get(item.productionId)!.items.push(item);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {Array.from(byProduction.entries()).map(([prodId, group]) => (
        <div key={prodId}>
          <p style={{
            margin: "0 0 8px", fontSize: 10, fontWeight: 700,
            letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)",
          }}>
            {group.name}
          </p>
          <div style={{ border: "1px solid var(--line)", borderRadius: 9, overflow: "hidden" }}>
            {group.items.map((cue, i) => (
              <Link
                key={cue.id}
                href={`/production/${cue.productionId}/cues`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 16px",
                  borderTop: i === 0 ? "none" : "1px solid var(--line)",
                  background: "var(--surface)",
                  textDecoration: "none",
                }}
              >
                <span style={{
                  fontFamily: "monospace", fontSize: 12, fontWeight: 700,
                  color: "var(--stage)", width: 72, flexShrink: 0, whiteSpace: "nowrap",
                }}>
                  {cue.cueListAbbr} {cue.number}
                </span>
                <span style={{
                  flex: 1, fontSize: 13, color: "var(--ink)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {cue.name || "（无名称）"}
                </span>
                {(cue.startKind === "gap" || cue.endKind === "gap") && (
                  <span style={{
                    fontSize: 9, padding: "2px 7px", borderRadius: 4,
                    background: "var(--danger-soft)", color: "var(--danger)",
                    fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap",
                  }}>
                    间隙端点
                  </span>
                )}
                <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>→</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
