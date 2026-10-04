"use client";

import { useState } from "react";
import { SECONDARY_BTN } from "@/components/ui/PageHeader";
import Badge from "@/components/ui/Badge";
import { BASE_PATH } from "@/lib/base-path";
import type { PrivateAssetRow } from "@/lib/asset/review-db";
import AdminMetricGrid from "@/components/admin/AdminMetricGrid";
import styles from "./admin-asset-review.module.css";

type Props = {
  productionId: string;
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

export default function AdminAssetReviewClient({ productionId, initialAssets, canEdit }: Props) {
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
      <AdminMetricGrid
        columns={3}
        items={[
          { value: String(assets.length), label: "隐私资产", hint: "未公开（is_public = false）" },
          { value: String(grantTotal), label: "实例授权", hint: "指向隐私资产的有效授权" },
          { value: String(assets.filter(a => a.mountCount === 0 && a.grants.length === 0).length), label: "零触达", hint: "无挂载且无授权" },
        ]}
      />

      <p style={{ margin: "0 0 14px", fontSize: 11, color: "var(--danger)", fontWeight: 700 }}>
        ⚠ 本页为越隐私合规审查：以下为成员未公开的数字资产，仅限合规用途查看与处置。
      </p>

      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: "6px 22px 22px" }}>
        {assets.map(a => {
          const open = expanded.has(a.id);
          return (
            <div key={a.id} style={{ borderBottom: "1px solid var(--line)" }}>
              <div className={styles.assetRow}>
                <button
                  onClick={() => toggle(a.id)}
                  className={styles.assetToggle}
                  aria-label={`${open ? "收起" : "展开"}${a.name || a.fileName}的授权名单`}
                  aria-expanded={open}
                >
                  {open ? "▾" : "▸"}
                </button>
                <div className={styles.assetDetails}>
                  <p className={styles.assetName}>
                    {a.name || a.fileName}
                  </p>
                  <p className={styles.fileMeta}>
                    {a.fileName} · 上传：{a.uploaderName || a.uploaderId.slice(0, 8)} · {fmtDate(a.createdAt)}
                  </p>
                </div>
                <div className={styles.assetActions}>
                  <div className={`${styles.assetTypeRow} ${styles.badgeCell}`}>
                    <Badge tone="neutral">{a.assetType}</Badge>
                  </div>
                  <div className={styles.assetCountRow}>
                    <span className={styles.badgeCell}>
                      <Badge tone={a.mountCount > 0 ? "blue" : "neutral"}>挂载 {a.mountCount}</Badge>
                    </span>
                    <span className={styles.badgeCell}>
                      <Badge tone={a.grants.length > 0 ? "amber" : "neutral"}>授权 {a.grants.length}</Badge>
                    </span>
                  </div>
                  {canEdit && (
                    <div className={styles.publicActionRow}>
                      <button
                        disabled={busy}
                        onClick={() => makePublic(a)}
                        style={{ ...SECONDARY_BTN, padding: "4px 10px", fontSize: 10 }}
                      >
                        设为公开
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {open && (
                <div className={styles.grantList}>
                  <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--stage)" }}>
                    授权名单（{a.grants.length}）
                  </p>
                  {a.grants.length === 0 && (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>无实例授权（仅上传者/挂载宿主路径可见）</p>
                  )}
                  {a.grants.map(g => (
                    <div key={g.grantId} className={styles.grantRow}>
                      <span className={styles.grantName}>
                        {g.userName || g.userId.slice(0, 8)}
                      </span>
                      <code className={styles.grantCode}>
                        {g.resourceSub === "*" ? "" : g.resourceSub + "@"}{g.permissionLevel}
                      </code>
                      <span className={styles.badgeCell}>
                        <Badge tone="neutral">{SOURCE_LABEL[g.grantSource] ?? g.grantSource}</Badge>
                      </span>
                      {canEdit && (
                        <button
                          disabled={busy}
                          onClick={() => revokeGrant(a, g.grantId)}
                          className={styles.revokeButton}
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
