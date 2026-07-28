"use client";

import { useState } from "react";
import SmartText from "@/components/SmartText";
import styles from "@/components/my-pages.module.css";

type Severity = "danger" | "warn" | "info";

type Announcement = {
  id: string;
  productionId: string;
  production: string;
  severity: Severity;
  title: string;
  body: string;
  time: string;
  author?: string;
};

// Demo data — backend will supply real productionIds
const DEMO: Announcement[] = [
  {
    id: "1",
    productionId: "demo-prod-1",
    production: "《碎片》2025 首演",
    severity: "danger",
    title: "第三幕灯光 Cue 存在时序冲突，需在彩排前解决",
    body: "根据 LD 最新递交的 Cue List，Cue 248–262 与舞监 Cue Sheet 中的字幕时序存在约 3 秒偏差，可能导致第三幕核心转场露馅。已标记为高优先级，请相关部门在 7 月 28 日下午 3 点前确认处理方案。\n\n目前临时措施：已要求灯光组暂缓提交最终 Cue，字幕组同步 Hold 相关时间轴。两组负责人请于 7 月 27 日晚 9 点前完成内部对稿，将更新结果发送至制作微信群。",
    time: "07-27 14:22",
    author: "王舞监",
  },
  {
    id: "2",
    productionId: "demo-prod-1",
    production: "《碎片》2025 首演",
    severity: "warn",
    title: "主角服装进度延迟，备选方案待确认",
    body: "服装组反馈主角 A 的第二套演出服因面料供货问题，完成时间从 7 月 25 日延至 8 月 3 日。已与导演沟通备选方案，待制作人确认后执行。\n\n备选方案：1. 沿用主角 A 第一套演出服（需洗涤、整烫）；2. 租借外部服装（需导演签字）。请制作人于本日内回复确认。",
    time: "07-27 10:05",
    author: "服装统筹李梅",
  },
  {
    id: "3",
    productionId: "demo-prod-2",
    production: "《盲目飞行》2025",
    severity: "danger",
    title: "场地方临时变更演出厅，影响所有装台计划",
    body: "场地方以维修为由通知将场地从主厅调换至小黑匣子，容量和舞台尺寸差异较大。技术总监正在评估影响范围，预计 24 小时内给出评估报告。请所有部门暂停当前装台计划，等待进一步通知。\n\n变更细节：主厅观众席约 800 位 → 小黑匣子约 200 位；舞台宽度 18m → 10m。灯光、音响、布景均需重新评估。",
    time: "07-26 18:40",
    author: "制作人陈江",
  },
  {
    id: "4",
    productionId: "demo-prod-2",
    production: "《盲目飞行》2025",
    severity: "info",
    title: "通告：7 月 30 日联排安排更新",
    body: "7 月 30 日联排时间调整为 14:00–20:00（原 10:00–16:00），地点不变。请各部门同步安排。Call Sheet 将于明日上午更新发送。\n\n请注意：上午原场地排练取消，下午 14:00 准时开始。午饭安排自理。",
    time: "07-26 09:15",
    author: "舞台监督",
  },
  {
    id: "5",
    productionId: "demo-prod-1",
    production: "《碎片》2025 首演",
    severity: "info",
    title: "假期通知：8 月 1–3 日制作组休息",
    body: "8 月 1 日至 3 日制作组休息，行政事务将延至 8 月 4 日处理。演出相关紧急事务请联系对应制作人。",
    time: "07-25 17:00",
    author: "制作人",
  },
];

const SEVERITY_LABEL: Record<Severity, string> = {
  danger: "风险",
  warn: "注意",
  info: "通知",
};

type Filter = "all" | Severity;

export default function AnnouncementsClient() {
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Announcement | null>(DEMO[0]);

  const filtered = filter === "all" ? DEMO : DEMO.filter(a => a.severity === filter);

  const dangerCount = DEMO.filter(a => a.severity === "danger").length;
  const warnCount = DEMO.filter(a => a.severity === "warn").length;

  const filterDefs: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "全部", count: DEMO.length },
    { key: "danger", label: "风险", count: dangerCount },
    { key: "warn", label: "注意", count: warnCount },
    { key: "info", label: "通知" },
  ];

  const severityBadgeStyle = (s: Severity) => ({
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: 5,
    padding: "3px 10px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    background: s === "danger" ? "var(--danger-soft)" : s === "warn" ? "var(--warn-soft)" : "var(--surface-2)",
    color: s === "danger" ? "var(--danger)" : s === "warn" ? "var(--warn)" : "var(--script)",
  });

  const severityDotStyle = (s: Severity) => ({
    width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
    background: s === "danger" ? "var(--danger)" : s === "warn" ? "var(--warn)" : "var(--script)",
  });

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>Platform · 公告</p>
        <h1 className={styles.pageTitle}>公告与风险提醒</h1>
      </div>

      {/* ── Mobile: single-column accordion ── */}
      <div className={styles.mobileOnly}>
        <div style={{ display: "flex", gap: 2 }}>
          {filterDefs.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                flex: 1, border: 0, borderRadius: 7, padding: "7px 0",
                fontSize: 11, fontWeight: 700, cursor: "pointer",
                background: filter === f.key ? "var(--ink)" : "var(--surface-2)",
                color: filter === f.key ? "#fff" : "var(--muted)",
              }}
            >
              {f.label}{f.count !== undefined && f.count > 0 && ` (${f.count})`}
            </button>
          ))}
        </div>

        <div className={styles.mobileCardList}>
          {filtered.map(item => {
            const isExpanded = selected?.id === item.id;
            return (
              <div key={item.id} className={`${styles.mobileCard} ${styles[item.severity]}`}>
                <button
                  onClick={() => setSelected(isExpanded ? null : item)}
                  className={styles.mobileCardBtn}
                >
                  <div className={styles.mobileCardHeader}>
                    <span className={styles.mobileCardProduction}>{item.production}</span>
                    <span className={styles.mobileCardTime}>{item.time}</span>
                  </div>
                  <p className={`${styles.mobileCardTitle} ${isExpanded ? "" : styles.mobileCardTitleClamp}`}>
                    {item.title}
                  </p>
                  {!isExpanded && (
                    <p className={styles.mobileCardPreview}>{item.body.split("\n")[0]}</p>
                  )}
                </button>

                {isExpanded && (
                  <div className={styles.mobileCardDetail}>
                    <div className={styles.mobileCardMeta}>
                      <span style={severityBadgeStyle(item.severity)}>
                        <span style={severityDotStyle(item.severity)} />
                        {SEVERITY_LABEL[item.severity]}
                      </span>
                      {item.author && (
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>{item.author} · {item.time}</span>
                      )}
                    </div>
                    <SmartText
                      content={item.body}
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

        <p style={{ marginTop: 20, fontSize: 11, color: "var(--muted)" }}>
          Demo 数据 · 后端接入后显示实际公告
        </p>
      </div>

      {/* ── Desktop: master-detail split ── */}
      <div className={styles.splitLayout}>
        {/* Left: list */}
        <div className={`${styles.splitPane} ${styles.splitList}`}>
          {/* Filter tabs */}
          <div style={{ display: "flex", gap: 2, marginBottom: 16, paddingRight: 16 }}>
            {filterDefs.map(f => (
              <button
                key={f.key}
                onClick={() => { setFilter(f.key); }}
                style={{
                  flex: 1,
                  border: 0,
                  borderRadius: 7,
                  padding: "6px 0",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  background: filter === f.key ? "var(--ink)" : "var(--surface-2)",
                  color: filter === f.key ? "#fff" : "var(--muted)",
                }}
              >
                {f.label}
                {f.count !== undefined && f.count > 0 && ` (${f.count})`}
              </button>
            ))}
          </div>

          {/* List */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingRight: 16 }}>
            {filtered.map(item => {
              const isSelected = selected?.id === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setSelected(item)}
                  style={{
                    border: `1px solid ${isSelected ? "var(--ink)" : item.severity === "danger" ? "#e0b4b4" : item.severity === "warn" ? "#e0cfb4" : "var(--line)"}`,
                    borderRadius: 10,
                    padding: "14px 16px",
                    background: isSelected ? "var(--ink)" : item.severity === "danger" ? "#fffafa" : item.severity === "warn" ? "#fffdf8" : "var(--surface)",
                    cursor: "pointer",
                    textAlign: "left",
                    width: "100%",
                    transition: "border-color .1s, background .1s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                      background: item.severity === "danger" ? "var(--danger)" : item.severity === "warn" ? "var(--warn)" : "var(--script)",
                    }} />
                    <span style={{
                      flex: 1, fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
                      textTransform: "uppercase",
                      color: isSelected ? "rgba(255,255,255,.6)" : "var(--muted)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {item.production}
                    </span>
                    <span style={{
                      fontSize: 10,
                      color: isSelected ? "rgba(255,255,255,.5)" : "var(--muted)",
                      whiteSpace: "nowrap", flexShrink: 0,
                    }}>
                      {item.time}
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

          <p style={{ marginTop: 20, fontSize: 11, color: "var(--muted)", paddingRight: 16 }}>
            Demo 数据 · 后端接入后显示实际公告
          </p>
        </div>

        {/* Right: detail */}
        <div className={`${styles.splitPane} ${styles.splitDetail}`}>
          {!selected ? (
            <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
              选择左侧公告查看详情
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 22 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                    background: selected.severity === "danger" ? "var(--danger-soft)" : selected.severity === "warn" ? "var(--warn-soft)" : "var(--surface-2)",
                    color: selected.severity === "danger" ? "var(--danger)" : selected.severity === "warn" ? "var(--warn)" : "var(--script)",
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                      background: selected.severity === "danger" ? "var(--danger)" : selected.severity === "warn" ? "var(--warn)" : "var(--script)",
                    }} />
                    {SEVERITY_LABEL[selected.severity]}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{selected.production}</span>
                </div>
                <h2 style={{
                  margin: "0 0 8px", fontFamily: 'Georgia, "Noto Serif SC", serif',
                  fontSize: "clamp(20px, 2vw, 28px)", fontWeight: 500, color: "var(--ink)",
                  lineHeight: 1.25,
                }}>
                  {selected.title}
                </h2>
                <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                  {selected.author && `${selected.author} · `}{selected.time}
                </p>
              </div>

              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 22 }}>
                <SmartText
                  content={selected.body}
                  markdown
                  contentMention={{ productionId: selected.productionId }}
                  className={styles.bodyText}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
