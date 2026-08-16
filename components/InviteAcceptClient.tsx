"use client";

import { useState } from "react";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import { BASE_PATH } from "@/lib/base-path";

type Props = {
  token: string;
  productionName: string | null;
  productionId: string | null;
  status: "active" | "revoked" | "expired" | "exhausted" | "not_found";
  targetedEmail: string | null;
  kind: "standard" | "claim";
  unclaimed: { id: string; name: string }[];
};

const STATUS_MSG: Record<Exclude<Props["status"], "active">, string> = {
  not_found: "邀请不存在或链接有误",
  revoked: "该邀请已被撤销",
  expired: "该邀请已过期",
  exhausted: "该邀请的使用次数已用完",
};

export default function InviteAcceptClient({ token, productionName, productionId, status, targetedEmail, kind, unclaimed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [claimId, setClaimId] = useState<string | null>(null);

  async function accept() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/invite/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "claim" ? { claimId } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "接受失败"); return; }
      setJoined(true);
      window.location.href = `${BASE_PATH}/production/${data.productionId}`;
    } catch { setError("网络错误"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{
      minHeight: "100vh", background: "var(--paper)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13,
        padding: "36px 40px", maxWidth: 440, width: "100%", textAlign: "center",
      }}>
        <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>
          Production Invitation
        </p>
        {status === "active" && productionName ? (
          <>
            <h1 style={{ margin: "0 0 10px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: "clamp(22px, 3vw, 30px)", fontWeight: 500, color: "var(--ink)", lineHeight: 1.25 }}>
              加入「{productionName}」
            </h1>
            <p style={{ margin: "0 0 22px", fontSize: 13, color: "var(--muted)", lineHeight: 1.7 }}>
              你被邀请加入该剧组项目。
              {targetedEmail && <><br />本邀请为定向邀请（{targetedEmail}）。</>}
              {kind === "claim" && <><br />请在名单中选择你的名字。</>}
            </p>
            {kind === "claim" && (
              <div style={{
                margin: "0 0 18px", maxHeight: "38vh", overflowY: "auto", textAlign: "left",
                border: "1px solid var(--line)", borderRadius: 10, padding: 8, background: "var(--paper)",
              }}>
                {unclaimed.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setClaimId(c.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left",
                      background: claimId === c.id ? "var(--script-soft)" : "transparent",
                    }}
                  >
                    <span style={{
                      width: 14, height: 14, borderRadius: 999, flexShrink: 0,
                      border: "1.5px solid " + (claimId === c.id ? "var(--script)" : "var(--line)"),
                      background: claimId === c.id ? "var(--script)" : "var(--surface)",
                    }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{c.name}</span>
                  </button>
                ))}
                {unclaimed.length === 0 && (
                  <p style={{ margin: 0, padding: "14px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
                    名单已全部认领
                  </p>
                )}
              </div>
            )}
            {error && <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <a href={BASE_PATH || "/"} style={{ ...SECONDARY_BTN, textDecoration: "none", display: "inline-block" }}>暂不加入</a>
              <button
                style={PRIMARY_BTN}
                disabled={busy || joined || (kind === "claim" && !claimId)}
                onClick={accept}
              >
                {joined ? "已加入，跳转中…" : busy ? "加入中…" : kind === "claim" ? "认领并加入" : "接受邀请"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 style={{ margin: "0 0 10px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 24, fontWeight: 500, color: "var(--ink)" }}>
              邀请不可用
            </h1>
            <p style={{ margin: "0 0 22px", fontSize: 13, color: "var(--muted)" }}>
              {STATUS_MSG[status as Exclude<Props["status"], "active">] ?? "邀请不可用"}
              {productionId ? "，如需加入请联系项目管理员重新发起。" : "。"}
            </p>
            <a href={BASE_PATH || "/"} style={{ ...SECONDARY_BTN, textDecoration: "none", display: "inline-block" }}>返回首页</a>
          </>
        )}
      </div>
    </div>
  );
}
