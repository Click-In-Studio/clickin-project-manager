"use client";

import { useEffect, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

// AI 用量卡片（#383）。两种语境同一个组件：
//   scope="production" —— 项目设置页，门是 node:ai/<prod>/usage@view（服务端判，
//                          没有键这个组件根本不渲染）；?members=1 拿到分解才显示明细。
//   scope="account"    —— 个人中心，看自己的额度全景。
//
// 数字都是 credit：1 credit ≈ 一个最便宜的 input token 的钱，一次问答约 1.2 万。
// 面向用户不解释这个单位，只给「用了多少 / 上限多少 / 什么时候恢复」。

type Window = { used: number; limit: number; resetAt: string };
type Quota = {
  tierLabel: string; exempt: boolean; daily: Window; weekly: Window;
  allowed: boolean; blockedBy: "daily" | "weekly" | null; extraRemaining?: number;
};
type Member = { userId: string; name: string; today: number; week: number };
type Payload = Quota & { today?: number; week?: number; members?: Member[] };

const CARD: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 8, padding: "17px 19px", marginTop: 18,
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "无限";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function resetText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
}

function Bar({ label, w }: { label: string; w: Window }) {
  // 无限档的 limit 是 Infinity，JSON 里会变成 null——不能让 `used >= null` 把条子染红
  const finite = Number.isFinite(w.limit) && w.limit > 0;
  const pct = finite ? Math.min(100, Math.round((w.used / w.limit) * 100)) : 0;
  const over = finite && w.used >= w.limit;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}>
        <span>{label}</span>
        <span style={{ color: over ? "var(--danger, #b3261e)" : "var(--ink)" }}>
          {fmt(w.used)} / {fmt(w.limit)}
        </span>
      </div>
      <div style={{ height: 5, marginTop: 4, borderRadius: 3, background: "var(--line)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: over ? "var(--danger, #b3261e)" : "var(--ink)" }} />
      </div>
      <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--muted)" }}>{resetText(w.resetAt)} 恢复</p>
    </div>
  );
}

export default function AiUsageCard({
  scope, productionId, canSeeMembers,
}: {
  scope: "production" | "account";
  productionId?: string;
  /** 项目语境下是否请求成员分解（node:ai/<prod>/usage/members@view）。 */
  canSeeMembers?: boolean;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = scope === "production"
      ? `${BASE_PATH}/api/production/${productionId}/ai-usage${canSeeMembers ? "?members=1" : ""}`
      : `${BASE_PATH}/api/account/ai-usage`;
    let cancelled = false;
    fetch(url)
      .then(async (r) => {
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(d.error ?? "读取失败"); return; }
        setData(scope === "production" ? { ...d.quota, today: d.today, week: d.week, members: d.members } : d);
      })
      .catch(() => { if (!cancelled) setError("网络错误"); });
    return () => { cancelled = true; };
  }, [scope, productionId, canSeeMembers]);

  if (error) return <section style={CARD}><h2 style={{ margin: 0, fontSize: 14 }}>AI 用量</h2><p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--muted)" }}>{error}</p></section>;
  if (!data) return <section style={CARD}><h2 style={{ margin: 0, fontSize: 14 }}>AI 用量</h2><p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--muted)" }}>读取中…</p></section>;

  return (
    <section style={CARD}>
      <h2 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>
        AI 用量
        {data.exempt && (
          <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "var(--accent-soft, rgba(120,90,40,.12))", color: "var(--accent, #8a6d3b)" }}>
            不限流
          </span>
        )}
      </h2>

      {data.exempt ? (
        <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--muted)" }}>
          {scope === "production" ? "本项目" : "你"}当前不受额度限制（{data.tierLabel}）。
          {scope === "production" && typeof data.week === "number" && <> 本项目本周已消耗 {fmt(data.week)}。</>}
        </p>
      ) : (
        <>
          <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--muted)" }}>
            {scope === "production"
              ? <>额度按项目所有者的档位（{data.tierLabel}）计，与他名下其他项目、个人会话共用一个池子。</>
              : <>当前档位：<b style={{ color: "var(--ink)" }}>{data.tierLabel}</b>。个人会话与你名下项目共用这份额度。</>}
          </p>
          <Bar label="今日" w={data.daily} />
          <Bar label="本周" w={data.weekly} />
          {typeof data.extraRemaining === "number" && data.extraRemaining !== 0 && (
            <p style={{ margin: "9px 0 0", fontSize: 12, color: data.extraRemaining < 0 ? "var(--danger, #b3261e)" : "var(--muted)" }}>
              额外额度余额：{fmt(data.extraRemaining)}
              {data.extraRemaining < 0 && "（已透支，下次补充先抵扣）"}
            </p>
          )}
          {!data.allowed && (
            <p style={{ margin: "9px 0 0", fontSize: 12, color: "var(--danger, #b3261e)" }}>
              {data.blockedBy === "weekly" ? "本周" : "今日"}额度已用尽，AI 暂不可用。
            </p>
          )}
        </>
      )}

      {scope === "production" && typeof data.today === "number" && !data.exempt && (
        <p style={{ margin: "9px 0 0", fontSize: 11, color: "var(--muted)" }}>
          其中本项目贡献：今日 {fmt(data.today)} · 本周 {fmt(data.week ?? 0)}
        </p>
      )}

      {data.members && data.members.length > 0 && (
        <div style={{ marginTop: 13 }}>
          <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--ink)" }}>本周按成员</p>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12, color: "var(--muted)" }}>
            {data.members.map((m) => (
              <li key={m.userId} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px solid var(--line)" }}>
                <span>{m.name}</span>
                <span>{fmt(m.week)}<span style={{ opacity: 0.6 }}>（今日 {fmt(m.today)}）</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
