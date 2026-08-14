"use client";

import { useState } from "react";
import Link from "next/link";
import type { ProductionReportEntry } from "@/lib/event-db";
import { fmtDate } from "@/lib/tz";
import SmartText, { scriptRefTextPlugin } from "@/components/SmartText";
import styles from "@/components/my-pages.module.css";

type RelFilter = "all" | "mentioned" | "follower" | "participant" | "other";
type PubFilter = "all" | "published" | "draft";

const REL_LABELS: Record<RelFilter, string> = {
  all: "全部",
  mentioned: "提到我",
  follower: "我关注",
  participant: "我参与",
  other: "其他",
};

const PUB_LABELS: Record<PubFilter, string> = {
  all: "全部",
  published: "已发布",
  draft: "未发布",
};

export default function ProductionReportsClient({
  productionId,
  reports,
  canViewDrafts,
}: {
  productionId: string;
  reports: ProductionReportEntry[];
  canViewDrafts: boolean;
}) {
  const [relFilter, setRelFilter] = useState<RelFilter>("all");
  const [pubFilter, setPubFilter] = useState<PubFilter>("all");
  const [selected, setSelected] = useState<ProductionReportEntry | null>(
    () => reports.find(r => r.publishedAt) ?? reports[0] ?? null
  );

  function matchRel(r: ProductionReportEntry, f: RelFilter) {
    if (f === "all") return true;
    if (f === "mentioned") return r.isMentioned;
    if (f === "follower") return r.isFollower && !r.isParticipant;
    if (f === "participant") return r.isParticipant;
    if (f === "other") return !r.isMentioned && !r.isFollower && !r.isParticipant;
    return true;
  }

  function matchPub(r: ProductionReportEntry, f: PubFilter) {
    if (f === "all") return true;
    if (f === "published") return !!r.publishedAt;
    if (f === "draft") return !r.publishedAt;
    return true;
  }

  const filtered = reports.filter(r => matchRel(r, relFilter) && matchPub(r, pubFilter));
  const visibleSelected = filtered.find(r => r.id === selected?.id) ?? null;

  function countRel(f: RelFilter) {
    return reports.filter(r => matchRel(r, f) && matchPub(r, pubFilter)).length;
  }
  function countPub(f: PubFilter) {
    return reports.filter(r => matchRel(r, relFilter) && matchPub(r, f)).length;
  }

  if (reports.length === 0) {
    return (
      <div className={styles.emptyState}>
        暂无报告
        <small>日程中发布报告后会在这里汇总</small>
      </div>
    );
  }

  const relFilters: RelFilter[] = ["all", "mentioned", "participant", "follower", "other"];
  const pubFilters: PubFilter[] = canViewDrafts ? ["all", "published", "draft"] : ["all", "published"];

  const summaryStats = {
    total: reports.length,
    published: reports.filter(r => r.publishedAt).length,
    draft: reports.filter(r => !r.publishedAt).length,
    mentioned: reports.filter(r => r.isMentioned).length,
  };

  return (
    <>
      {/* ── 摘要统计（原型 taskSummary 语汇）── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(summaryStats.total), "全部报告", "本项目累计"],
          [String(summaryStats.published), "已发布", "全员可读"],
          [String(summaryStats.draft), "草稿", canViewDrafts ? "待发布" : "对你不可见"],
          [String(summaryStats.mentioned), "提到我", "报告中被 @ "],
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

      {/* ── Panel（原型排版）：内部维持现有分栏 ── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column" }}>
      {/* ── Mobile: filter chips + accordion ── */}
      <div className={styles.mobileOnly}>
        <div className={styles.mobileTaskFilterBar}>
          <div className={styles.mobileTaskStatusScroll}>
            {relFilters.map(f => (
              <button
                key={f}
                onClick={() => setRelFilter(f)}
                className={`${styles.mobileTaskChip} ${relFilter === f ? styles.active : ""}`}
              >
                {REL_LABELS[f]} ({countRel(f)})
              </button>
            ))}
          </div>
          {pubFilters.length > 1 && (
            <div className={styles.mobileTaskStatusScroll}>
              {pubFilters.map(f => (
                <button
                  key={f}
                  onClick={() => setPubFilter(f)}
                  className={`${styles.mobileTaskChip} ${pubFilter === f ? styles.active : ""}`}
                >
                  {PUB_LABELS[f]} ({countPub(f)})
                </button>
              ))}
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className={styles.emptyState}>无匹配报告</div>
        ) : (
          <div className={styles.mobileTaskList}>
            {filtered.map(r => {
              const isExpanded = selected?.id === r.id;
              const isPendingDraft = !r.publishedAt && r.eventStatus === "completed";
              const tags: string[] = [];
              if (r.isMentioned) tags.push("提到我");
              if (r.isParticipant) tags.push("参与");
              else if (r.isFollower) tags.push("关注");
              return (
                <div key={r.id} className={styles.mobileTaskCard}>
                  <button
                    className={styles.mobileTaskCardBtn}
                    onClick={() => setSelected(isExpanded ? null : r)}
                  >
                    <div className={styles.mobileTaskCardMeta}>
                      <span className={styles.mobileTaskCardKicker}>{r.eventTitle}</span>
                      <span style={{
                        flexShrink: 0, borderRadius: 6, padding: "3px 8px",
                        fontSize: 10, fontWeight: 700,
                        ...(r.publishedAt ? { background: "#f0fdf4", color: "#16a34a" } : { background: "#f2e4d9", color: "var(--stage)" }),
                      }}>
                        {r.publishedAt ? "已发布" : isPendingDraft ? "待完成" : "草稿"}
                      </span>
                    </div>
                    <p className={`${styles.mobileTaskCardTitle} ${isExpanded ? "" : styles.mobileTaskCardTitleClamp}`}
                       style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      {isPendingDraft && <span className={styles.pendingDraftDot} style={{ flexShrink: 0 }} />}
                      {r.title || "未命名报告"}
                    </p>
                    {tags.length > 0 && (
                      <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                        {tags.map(tag => (
                          <span key={tag} style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--paper)", color: "var(--muted)" }}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>

                  {isExpanded && (
                    <div className={styles.mobileTaskCardDetail}>
                      {r.publishedAt && (
                        <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--muted)" }}>
                          已发布 · {fmtDate(r.publishedAt)}
                        </p>
                      )}
                      {r.body && (
                        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginBottom: 14 }}>
                          <SmartText content={r.body} plugins={[scriptRefTextPlugin]} productionId={productionId} />
                        </div>
                      )}
                      <Link
                        href={`/production/${productionId}/reports/${r.id}`}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6,
                          border: "1px solid var(--ink)", borderRadius: 8, padding: "9px 18px",
                          fontSize: 12, fontWeight: 700, color: "var(--ink)", textDecoration: "none",
                        }}
                      >
                        阅读完整报告 →
                      </Link>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Desktop: 3-column layout ── */}
      <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 420px", gap: 0, height: "100%", minHeight: 0 }}>
          {/* Left: filters */}
          <div style={{ borderRight: "1px solid var(--line)", padding: "0 16px 24px 0", overflowY: "auto" }}>
            <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 8px" }}>与我的关系</h3>
            <div className={styles.filterList}>
              {relFilters.map(f => (
                <button key={f} className={`${styles.filterItem} ${relFilter === f ? styles.active : ""}`} onClick={() => setRelFilter(f)}>
                  <span>{REL_LABELS[f]}</span>
                  <span className={styles.filterCount}>{countRel(f)}</span>
                </button>
              ))}
            </div>
            <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", margin: "20px 0 8px" }}>状态</h3>
            <div className={styles.filterList}>
              {pubFilters.map(f => (
                <button key={f} className={`${styles.filterItem} ${pubFilter === f ? styles.active : ""}`} onClick={() => setPubFilter(f)}>
                  <span>{PUB_LABELS[f]}</span>
                  <span className={styles.filterCount}>{countPub(f)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Middle: report list */}
          <div style={{ borderRight: "1px solid var(--line)", overflowY: "auto", padding: "0 0 24px 20px" }}>
            {filtered.length === 0 ? (
              <div className={styles.emptyState} style={{ paddingTop: 60 }}>无匹配报告</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {filtered.map(r => {
                  const isSelected = visibleSelected?.id === r.id;
                  const isPendingDraft = !r.publishedAt && r.eventStatus === "completed";
                  const tags: string[] = [];
                  if (r.isMentioned) tags.push("提到我");
                  if (r.isParticipant) tags.push("参与");
                  else if (r.isFollower) tags.push("关注");
                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelected(r)}
                      style={{
                        border: "1px solid " + (isSelected ? "var(--ink)" : "transparent"),
                        borderRadius: 10, padding: "13px 16px",
                        background: isSelected ? "var(--ink)" : "transparent",
                        cursor: "pointer", textAlign: "left", width: "100%",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{
                            margin: "0 0 3px", fontSize: 10, fontWeight: 700,
                            letterSpacing: ".08em", textTransform: "uppercase",
                            color: isSelected ? "rgba(255,255,255,.5)" : "var(--muted)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>
                            {r.eventTitle}
                          </p>
                          <p style={{
                            margin: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.35,
                            color: isSelected ? "#fff" : "var(--ink)",
                            display: "flex", alignItems: "center", gap: 7,
                          }}>
                            {isPendingDraft && !isSelected && <span className={styles.pendingDraftDot} style={{ flexShrink: 0 }} />}
                            <span style={{
                              display: "-webkit-box", WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical", overflow: "hidden",
                            }}>
                              {r.title || "未命名报告"}
                            </span>
                          </p>
                          {tags.length > 0 && (
                            <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                              {tags.map(tag => (
                                <span key={tag} style={{
                                  fontSize: 10, padding: "1px 6px", borderRadius: 4,
                                  background: isSelected ? "rgba(255,255,255,.15)" : "var(--paper)",
                                  color: isSelected ? "rgba(255,255,255,.7)" : "var(--muted)",
                                }}>{tag}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ flexShrink: 0, textAlign: "right" }}>
                          <span style={{
                            display: "block", borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700,
                            ...(isSelected
                              ? { background: "rgba(255,255,255,.15)", color: "rgba(255,255,255,.8)" }
                              : r.publishedAt
                                ? { background: "#f0fdf4", color: "#16a34a" }
                                : { background: "#f2e4d9", color: "var(--stage)" }),
                          }}>
                            {r.publishedAt ? "已发布" : isPendingDraft ? "待完成" : "草稿"}
                          </span>
                          {r.publishedAt && (
                            <span style={{ display: "block", marginTop: 3, fontSize: 10, color: isSelected ? "rgba(255,255,255,.4)" : "var(--muted)" }}>
                              {fmtDate(r.publishedAt)}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: detail */}
          <div style={{ overflowY: "auto", padding: "0 0 24px 24px" }}>
            {!visibleSelected ? (
              <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧报告查看</div>
            ) : (
              <div>
                <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
                  {visibleSelected.eventTitle}
                </p>
                <h2 style={{
                  margin: "0 0 12px", fontFamily: 'Georgia, "Noto Serif SC", serif',
                  fontSize: "clamp(18px, 1.8vw, 24px)", fontWeight: 500, color: "var(--ink)", lineHeight: 1.3,
                }}>
                  {visibleSelected.title || "未命名报告"}
                </h2>
                <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                  <span style={{
                    borderRadius: 6, padding: "3px 10px", fontSize: 11, fontWeight: 600,
                    ...(visibleSelected.publishedAt
                      ? { background: "#f0fdf4", color: "#16a34a" }
                      : { background: "#f2e4d9", color: "var(--stage)" }),
                  }}>
                    {visibleSelected.publishedAt
                      ? `已发布 · ${fmtDate(visibleSelected.publishedAt)}`
                      : visibleSelected.eventStatus === "completed" ? "待完成" : "草稿"}
                  </span>
                </div>
                {visibleSelected.body && (
                  <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, marginBottom: 20 }}>
                    <SmartText content={visibleSelected.body} plugins={[scriptRefTextPlugin]} productionId={productionId} />
                  </div>
                )}
                <Link
                  href={`/production/${productionId}/reports/${visibleSelected.id}`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    border: "1px solid var(--ink)", borderRadius: 8, padding: "9px 18px",
                    fontSize: 12, fontWeight: 700, color: "var(--ink)", textDecoration: "none",
                  }}
                >
                  阅读完整报告 →
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
      </section>
    </>
  );
}