"use client";

import { useState } from "react";
import PageHeader, { SECONDARY_BTN } from "@/components/PageHeader";
import Badge from "@/components/Badge";
import { BASE_PATH } from "@/lib/base-path";
import type { PrivateAssetRow } from "@/lib/asset/review-db";

type Props = {
  productionId: string;
  productionName: string;
  initialAssets: PrivateAssetRow[];
  canEdit: boolean;
};

const SOURCE_LABEL: Record<string, string> = {
  self_confirmed: "自确认", auto: "自动", approval: "审批",
  direct: "直接授予", assigned: "指派", migrated: "迁移",
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export default function AdminAssetReviewClient({ productionId, productionName, initialAssets, canEdit }: Props) {
  const [assets, setAssets] = useState<PrivateAssetRow[]>(initialAssets);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const grantTotal = assets.reduce((n, a) => n + a.grants.length, 0);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/asset-review`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "操作失败"); return false; }
      return true;
    } catch { setError("网络错误"); return false; }
    finally { setBusy(false); }
  }

  async function makePublic(a: PrivateAssetRow) {
    if (!confirm(`确认将「${a.name || a.fileName}」设为公开？全项目具备资产能力票的成员都将可见。`)) return;
    if (await post({ action: "set_public", assetId: a.id })) {
      setAssets(prev => prev.filter(x => x.id !== a.id));
    }
  }

  async function revokeGrant(a: PrivateAssetRow, grantId: string) {
    if (!confirm("确认撤销该条资产授权？")) return;
    if (await post({ action: "revoke_grant", grantId })) {
      setAssets(prev => prev.map(x => (x.id === a.id ? { ...x, grants: x.grants.filter(g => g.grantId !== grantId) } : x)));
    }
  }

  function toggle(id: string) {
    setExpanded(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title="数字资产审查" side="stage" />

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(assets.length), "隐私资产", "未公开（is_public = false）"],
          [String(grantTotal), "实例授权", "指向隐私资产的有效授权"],
          [String(assets.filter(a => a.mountCount === 0 && a.grants.length === 0).length), "零触达", "无挂载且无授权"],
        ].map(([num, label, hint]) => (
          <div key={label} style={{ minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13, background: "var(--surface)" }}>
            <span style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28, color: "var(--ink)" }}>{num}</span>
            <p style={{ margin: 0, display: "flex", flexDirection: "column" }}>
              <b style={{ fontSize: 11, color: "var(--ink)" }}>{label}</b>
              <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 9 }}>{hint}</small>
            </p>
          </div>
        ))}
      </div>

      <p style={{ margin: "0 0 14px", fontSize: 11, color: "var(--danger)", fontWeight: 700 }}>
        ⚠ 本页为越隐私合规审查：以下为成员未公开的数字资产，仅限合规用途查看与处置。
      </p>

      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: "6px 22px 22px" }}>
        {assets.map(a => {
          const open = expanded.has(a.id);
          return (
            <div key={a.id} style={{ borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0" }}>
                <button
                  onClick={() => toggle(a.id)}
                  style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--muted)", fontSize: 11, width: 18 }}
                >
                  {open ? "▾" : "▸"}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name || a.fileName}
                  </p>
                  <p style={{ margin: "2px 0 0", fontSize: 10, color: "var(--muted)" }}>
                    {a.fileName} · 上传：{a.uploaderName || a.uploaderId.slice(0, 8)} · {fmtDate(a.createdAt)}
                  </p>
                </div>
                <Badge tone="neutral">{a.assetType}</Badge>
                <Badge tone={a.mountCount > 0 ? "blue" : "neutral"}>挂载 {a.mountCount}</Badge>
                <Badge tone={a.grants.length > 0 ? "amber" : "neutral"}>授权 {a.grants.length}</Badge>
                {canEdit && (
                  <button
                    disabled={busy}
                    onClick={() => makePublic(a)}
                    style={{ ...SECONDARY_BTN, padding: "4px 10px", fontSize: 10 }}
                  >
                    设为公开
                  </button>
                )}
              </div>
              {open && (
                <div style={{ padding: "0 0 12px 28px" }}>
                  <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--stage)" }}>
                    授权名单（{a.grants.length}）
                  </p>
                  {a.grants.length === 0 && (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>无实例授权（仅上传者/挂载宿主路径可见）</p>
                  )}
                  {a.grants.map(g => (
                    <div key={g.grantId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", minWidth: 80 }}>
                        {g.userName || g.userId.slice(0, 8)}
                      </span>
                      <code style={{ flex: 1, fontSize: 10, color: "var(--muted)" }}>
                        {g.resourceSub === "*" ? "" : g.resourceSub + "@"}{g.permissionLevel}
                      </code>
                      <Badge tone="neutral">{SOURCE_LABEL[g.grantSource] ?? g.grantSource}</Badge>
                      {canEdit && (
                        <button
                          disabled={busy}
                          onClick={() => revokeGrant(a, g.grantId)}
                          style={{ ...SECONDARY_BTN, padding: "2px 8px", fontSize: 10, borderColor: "var(--danger)", color: "var(--danger)" }}
                        >
                          撤销
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {assets.length === 0 && (
          <p style={{ padding: "30px 0", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            无隐私资产
          </p>
        )}
      </section>
    </div>
  );
}
