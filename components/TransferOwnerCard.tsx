"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

type Props = {
  productionId: string;
  currentOwnerName: string | null;
  members: { userId: string; name: string }[];
  ownerId: string | null;
};

export default function TransferOwnerCard({ productionId, currentOwnerName, members, ownerId }: Props) {
  const [newOwnerId, setNewOwnerId] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = members.find(m => m.userId === newOwnerId);
  const armed = target && confirmText === (target.name || "");

  async function transfer() {
    if (!armed) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/transfer-owner`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "转让失败"); return; }
      setMsg(`已转让给 ${target!.name}。你已不再是 Owner，部分管理入口将随下次刷新收回。`);
      setNewOwnerId(""); setConfirmText("");
    } catch { setError("网络错误"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--danger)", borderRadius: 13, padding: 22, marginBottom: 18 }}>
      <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--danger)" }}>
        Root Operation
      </p>
      <h3 style={{ margin: "0 0 6px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>
        转让 Owner
      </h3>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
        当前 Owner：{currentOwnerName ?? "（未设置）"}。转让后对方获得全部权限（代码旁路），你将失去 Owner 身份，此操作只能由新 Owner 逆转。
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={newOwnerId}
          onChange={e => { setNewOwnerId(e.target.value); setConfirmText(""); }}
          style={{ padding: "8px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", minWidth: 160 }}
        >
          <option value="">选择新 Owner…</option>
          {members.filter(m => m.userId !== ownerId).map(m => (
            <option key={m.userId} value={m.userId}>{m.name || m.userId.slice(0, 8)}</option>
          ))}
        </select>
        {target && (
          <input
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            placeholder={`输入「${target.name}」以确认`}
            style={{ padding: "8px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", minWidth: 180 }}
          />
        )}
        <button
          disabled={busy || !armed}
          onClick={transfer}
          style={{
            padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: armed ? "pointer" : "not-allowed",
            border: "1px solid var(--danger)", background: armed ? "var(--danger)" : "var(--paper)",
            color: armed ? "#fff" : "var(--muted)",
          }}
        >
          确认转让
        </button>
      </div>
      {msg && <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--success)", fontWeight: 700 }}>{msg}</p>}
      {error && <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}
    </div>
  );
}
