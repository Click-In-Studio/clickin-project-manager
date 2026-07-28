"use client";

import { useState } from "react";
import SmartText from "@/components/SmartText";
import styles from "@/components/my-pages.module.css";

type NotifKind = "action" | "info";
type NotifStatus = "pending" | "read" | "done";

type Notification = {
  id: string;
  kind: NotifKind;
  status: NotifStatus;
  title: string;
  meta: string;
  productionId: string;
  production: string;
  body: string;
  time: string;
};

const DEMO: Notification[] = [
  {
    id: "1",
    kind: "action",
    status: "pending",
    title: "请确认：7 月 30 日联排 Call Time",
    meta: "联排 01",
    productionId: "demo-prod-1",
    production: "《碎片》2025 首演",
    body: '你的 Call Time 为 14:00，地点为排练厅 B。请点击「确认已收到」以让制作方知晓你已收到此通知。\n\n如有任何冲突，请直接联系舞台监督。',
    time: "今天 10:22",
  },
  {
    id: "2",
    kind: "action",
    status: "pending",
    title: "请确认：灯光 Cue List v3 更新",
    meta: "技术需求",
    productionId: "demo-prod-1",
    production: "《碎片》2025 首演",
    body: "灯光设计已提交 Cue List v3，对第三幕时序进行了重要修改。请在 7 月 28 日 12:00 前确认收到并完成内部对稿。",
    time: "今天 09:05",
  },
  {
    id: "3",
    kind: "info",
    status: "pending",
    title: "Call Sheet 已更新：8 月 1 日演出",
    meta: "Event 003",
    productionId: "demo-prod-1",
    production: "《碎片》2025 首演",
    body: "8 月 1 日演出 Call Sheet 已更新，Call Time 部分有变动。请查阅最新版本。",
    time: "昨天 18:40",
  },
  {
    id: "4",
    kind: "action",
    status: "done",
    title: "请确认：7 月 25 日联排 Call Time",
    meta: "联排 00",
    productionId: "demo-prod-1",
    production: "《碎片》2025 首演",
    body: "你的 Call Time 为 10:00，地点为排练厅 A。",
    time: "07-25 10:00",
  },
  {
    id: "5",
    kind: "info",
    status: "read",
    title: "报告已发布：7 月 22 日演出 Production Report",
    meta: "Event 007",
    productionId: "demo-prod-2",
    production: "《盲目飞行》2025",
    body: "7 月 22 日演出 Production Report 已发布，请前往查阅。",
    time: "07-22 23:15",
  },
  {
    id: "6",
    kind: "info",
    status: "read",
    title: "服装部门提交了物料清单",
    meta: "物料",
    productionId: "demo-prod-2",
    production: "《盲目飞行》2025",
    body: "服装部门已完成物料清单提交，共 47 项。如有疑问请联系服装统筹。",
    time: "07-21 14:30",
  },
  {
    id: "7",
    kind: "action",
    status: "done",
    title: "请确认：场地变更通知",
    meta: "运营",
    productionId: "demo-prod-2",
    production: "《盲目飞行》2025",
    body: "演出场地已从主厅调换至小黑匣子，详情请见公告。",
    time: "07-20 09:00",
  },
];

type Tab = "all" | "action" | "info" | "done";

const TAB_LABELS: Record<Tab, string> = {
  all: "全部",
  action: "待确认",
  info: "仅告知",
  done: "已处理",
};

export default function MyNotificationsClient() {
  const [tab, setTab] = useState<Tab>("all");
  const [items, setItems] = useState<Notification[]>(DEMO);
  const [selected, setSelected] = useState<Notification | null>(DEMO[0]);

  const filtered = items.filter(n => {
    if (tab === "all") return n.status !== "done";
    if (tab === "action") return n.kind === "action" && n.status === "pending";
    if (tab === "info") return n.kind === "info" && n.status !== "done";
    if (tab === "done") return n.status === "done";
    return true;
  });

  const pendingActionCount = items.filter(n => n.kind === "action" && n.status === "pending").length;

  const markDone = (id: string) => {
    setItems(prev => prev.map(n => n.id === id ? { ...n, status: "done" } : n));
    if (selected?.id === id) setSelected(prev => prev ? { ...prev, status: "done" } : null);
  };

  function dotColor(n: Notification) {
    if (n.kind === "action" && n.status === "pending") return "var(--stage)";
    if (n.status === "pending") return "var(--script)";
    return "var(--line)";
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>Platform · 通知</p>
        <h1 className={styles.pageTitle}>通知提醒</h1>
      </div>

      <div className={styles.tabBar}>
        {(["all", "action", "info", "done"] as Tab[]).map(t => (
          <button key={t} aria-selected={tab === t} onClick={() => setTab(t)}>
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
      </div>

      {/* ── Mobile: accordion list ── */}
      <div className={styles.mobileOnly}>
        {filtered.length === 0 ? (
          <div className={styles.emptyState}>
            暂无{tab !== "all" ? TAB_LABELS[tab] : ""}通知
            <small>新的通知将在这里显示</small>
          </div>
        ) : (
          <div className={styles.mobileCardList}>
            {filtered.map(n => {
              const isExpanded = selected?.id === n.id;
              return (
                <div
                  key={n.id}
                  className={styles.mobileCard}
                  style={{ borderLeftColor: dotColor(n) }}
                >
                  <button
                    className={styles.mobileCardBtn}
                    onClick={() => setSelected(isExpanded ? null : n)}
                  >
                    <div className={styles.mobileCardHeader}>
                      <span className={styles.mobileCardProduction}>
                        {n.production} · {n.meta}
                      </span>
                      <span className={styles.mobileCardTime}>{n.time}</span>
                    </div>
                    <p className={`${styles.mobileCardTitle} ${isExpanded ? "" : styles.mobileCardTitleClamp}`}>
                      {n.title}
                    </p>
                  </button>

                  {isExpanded && (
                    <div className={styles.mobileCardDetail}>
                      <div className={styles.mobileCardMeta}>
                        <span style={{
                          padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                          background: n.kind === "action" ? "var(--warn-soft)" : "var(--surface-2)",
                          color: n.kind === "action" ? "var(--warn)" : "var(--script)",
                        }}>
                          {n.kind === "action" ? "待确认" : "告知"}
                        </span>
                        {n.status === "done" && (
                          <span style={{
                            padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                            background: "var(--success-soft)", color: "var(--success)",
                          }}>
                            已处理
                          </span>
                        )}
                      </div>
                      <SmartText
                        content={n.body}
                        markdown
                        contentMention={{ productionId: n.productionId }}
                        className={styles.bodyText}
                      />
                      {n.kind === "action" && n.status === "pending" && (
                        <button
                          onClick={() => markDone(n.id)}
                          style={{
                            marginTop: 16, border: "1px solid var(--ink)",
                            background: "var(--ink)", borderRadius: 8,
                            padding: "10px 24px", fontSize: 13, fontWeight: 700,
                            color: "#fff", cursor: "pointer",
                          }}
                        >
                          确认已收到
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p style={{ marginTop: 20, fontSize: 11, color: "var(--muted)" }}>
          Demo 数据 · 后端接入后显示实际通知
        </p>
      </div>

      {/* ── Desktop: master-detail split ── */}
      <div className={styles.desktopOnly}>
        <div className={styles.splitLayout}>
          {/* Left: list */}
          <div className={`${styles.splitPane} ${styles.splitList}`}>
            {filtered.length === 0 ? (
              <div className={styles.emptyState} style={{ paddingTop: 40, paddingRight: 16 }}>
                暂无{tab !== "all" ? TAB_LABELS[tab] : ""}通知
                <small>新的通知将在这里显示</small>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 16 }}>
                {filtered.map(n => {
                  const isSelected = selected?.id === n.id;
                  return (
                    <button
                      key={n.id}
                      onClick={() => setSelected(n)}
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
                          margin: "0 0 3px", fontSize: 13, fontWeight: 600,
                          color: isSelected ? "#fff" : "var(--ink)",
                          display: "-webkit-box", WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: 1.35,
                        }}>
                          {n.title}
                        </p>
                        <p style={{ margin: 0, fontSize: 11, color: isSelected ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
                          {n.production} · {n.meta}
                        </p>
                      </div>
                      <span style={{
                        fontSize: 10, color: isSelected ? "rgba(255,255,255,.5)" : "var(--muted)",
                        whiteSpace: "nowrap", flexShrink: 0, marginTop: 2,
                      }}>
                        {n.time}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <p style={{ marginTop: 20, paddingRight: 16, fontSize: 11, color: "var(--muted)" }}>
              Demo 数据 · 后端接入后显示实际通知
            </p>
          </div>

          {/* Right: detail */}
          <div className={`${styles.splitPane} ${styles.splitDetail}`}>
            {!selected ? (
              <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                选择左侧通知查看详情
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <span style={{
                      padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                      background: selected.kind === "action" ? "var(--warn-soft)" : "var(--surface-2)",
                      color: selected.kind === "action" ? "var(--warn)" : "var(--script)",
                    }}>
                      {selected.kind === "action" ? "待确认" : "告知"}
                    </span>
                    {selected.status === "done" && (
                      <span style={{
                        padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                        background: "var(--success-soft)", color: "var(--success)",
                      }}>
                        已处理
                      </span>
                    )}
                  </div>
                  <h2 style={{
                    margin: "0 0 6px",
                    fontFamily: 'Georgia, "Noto Serif SC", serif',
                    fontSize: "clamp(18px, 2vw, 24px)", fontWeight: 500, color: "var(--ink)",
                    lineHeight: 1.3,
                  }}>
                    {selected.title}
                  </h2>
                  <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                    {selected.production} · {selected.meta} · {selected.time}
                  </p>
                </div>

                <div style={{ borderTop: "1px solid var(--line)", paddingTop: 20, marginBottom: 24 }}>
                  <SmartText
                    content={selected.body}
                    markdown
                    contentMention={{ productionId: selected.productionId }}
                    className={styles.bodyText}
                  />
                </div>

                {selected.kind === "action" && selected.status === "pending" && (
                  <button
                    onClick={() => markDone(selected.id)}
                    style={{
                      border: "1px solid var(--ink)", background: "var(--ink)",
                      borderRadius: 8, padding: "10px 24px",
                      fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer",
                    }}
                  >
                    确认已收到
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
