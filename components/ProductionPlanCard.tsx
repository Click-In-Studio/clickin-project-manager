"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

// 项目档位卡片（#280）：展示当前档位/特邀豁免，owner 可兑换项目升级码。
// 档位 limit 文案由服务端传入（lib/plan.ts 不可入客户端包）。

type Props = {
  productionId: string;
  isOwner: boolean;
  initial: { tier: string; label: string; billingExempt: boolean; seatLimit: number; ai: boolean; advancedPerms: boolean };
};

export default function ProductionPlanCard({ productionId, isOwner, initial }: Props) {
  const [plan, setPlan] = useState(initial);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function redeem() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/redeem-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg({ ok: false, text: data.error ?? "兑换失败" }); return; }
      setPlan(p => ({ ...p, tier: data.tier, label: data.tierLabel ?? data.tier, billingExempt: data.billingExempt }));
      setCode("");
      setMsg({ ok: true, text: `兑换成功，当前档位：${data.tierLabel ?? data.tier}。部分功能开关在下次刷新后生效。` });
    } catch {
      setMsg({ ok: false, text: "网络错误，请重试" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: "17px 19px", marginTop: 18 }}>
      <h2 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>
        项目档位
        {plan.billingExempt && (
          <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "var(--accent-soft, rgba(120,90,40,.12))", color: "var(--accent, #8a6d3b)" }}>
            特邀项目
          </span>
        )}
      </h2>
      <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--muted)" }}>
        当前档位：<b style={{ color: "var(--ink)" }}>{plan.label}</b>
        {" · "}成员上限 {plan.seatLimit} 人
        {" · "}AI 助手{plan.ai ? "已开通" : "未开通"}
        {" · "}高级权限配置{plan.advancedPerms ? "已开通" : "未开通"}
      </p>
      {isOwner ? (
        <div style={{ marginTop: 13, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="输入项目升级码"
            disabled={busy}
            style={{ flex: "1 1 220px", maxWidth: 320, padding: "7px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--ink)" }}
          />
          <button
            type="button"
            onClick={redeem}
            disabled={busy || !code.trim()}
            style={{ padding: "7px 16px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 6, background: "var(--ink)", color: "var(--surface)", cursor: busy ? "default" : "pointer" }}
          >
            {busy ? "兑换中…" : "兑换"}
          </button>
          {msg && (
            <p style={{ margin: 0, width: "100%", fontSize: 12, color: msg.ok ? "var(--ok, #2c7a4b)" : "var(--danger, #b3261e)" }}>{msg.text}</p>
          )}
        </div>
      ) : (
        <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--muted)" }}>档位升级码由项目所有者兑换。</p>
      )}
    </section>
  );
}
