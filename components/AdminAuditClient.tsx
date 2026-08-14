"use client";

import { useMemo, useState } from "react";
import PageHeader, { SECONDARY_BTN } from "@/components/PageHeader";
import Badge from "@/components/Badge";
import MemberPickerModal, { type PickerMember, type PickerDept } from "@/components/MemberPickerModal";
import { BASE_PATH } from "@/lib/base-path";
import type { GrantLedgerRow } from "@/lib/grant-audit-db";

type Props = {
  productionId: string;
  productionName: string;
  initialRows: GrantLedgerRow[];
  initialTotal: number;
  members: PickerMember[];
  depts: PickerDept[];
  canRevoke: boolean;
};

const SOURCE_LABEL: Record<string, string> = {
  self_confirmed: "自确认",
  auto: "自动",
  approval: "审批",
  direct: "直接授予",
  assigned: "指派",
  migrated: "迁移",
};

const REASON_LABEL: Record<string, string> = {
  role_change: "角色变更",
  dept_change: "部门变更",
  dept_dissolved: "部门解散",
  poc_change: "POC 变更",
  manual: "手动撤销",
  member_removed: "成员清退",
};

const FIELD: React.CSSProperties = {
  padding: "7px 9px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8,
  background: "var(--surface)", color: "var(--ink)",
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nodeKey(r: GrantLedgerRow) {
  const sub = r.resourceSub === "*" ? "" : `/${r.resourceSub}`;
  return `node:${r.resourceType}/${r.resourceId}${sub}@${r.permissionLevel}`;
}

export default function AdminAuditClient({
  productionId, productionName, initialRows, initialTotal, members, depts, canRevoke,
}: Props) {
  const [rows, setRows] = useState<GrantLedgerRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [filters, setFilters] = useState({ user: "", type: "", source: "", status: "" });
  const [userPickerOpen, setUserPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resourceTypes = useMemo(
    () => [...new Set(initialRows.map(r => r.resourceType))].sort(),
    [initialRows],
  );

  const activeCount = rows.filter(r => r.status === "active").length;
  const revokedCount = rows.filter(r => r.status === "revoked").length;

  function buildQuery(f: typeof filters, offset: number) {
    const p = new URLSearchParams();
    if (f.user) p.set("user", f.user);
    if (f.type) p.set("type", f.type);
    if (f.source) p.set("source", f.source);
    if (f.status) p.set("status", f.status);
    p.set("limit", "100");
    if (offset) p.set("offset", String(offset));
    return p.toString();
  }

  async function load(f: typeof filters, offset = 0) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/grants?${buildQuery(f, offset)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "加载失败"); return; }
      setTotal(data.total ?? 0);
      setRows(prev => (offset ? [...prev, ...data.rows] : data.rows));
    } catch { setError("网络错误"); }
    finally { setBusy(false); }
  }

  function applyFilter(patch: Partial<typeof filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    load(next, 0);
  }

  async function revoke(row: GrantLedgerRow) {
    if (!confirm(`确认强制撤销 ${row.userName || row.userId} 的授权？\n${nodeKey(row)}`)) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/grants`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId: row.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "撤销失败"); return; }
      setRows(prev => prev.map(r => (r.id === row.id ? { ...r, isRevoked: true, revokedReason: "manual", status: "revoked" as const } : r)));
    } catch { setError("网络错误"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title="权限审计" side="stage" />

      {/* 摘要 */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(total), "流水总数", "当前筛选"],
          [String(activeCount), "有效", "本页内"],
          [String(revokedCount), "已撤销", "本页内"],
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

      {/* 筛选条 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {/* 伪 select：外观同原生下拉，点开是人员 picker modal */}
        <button
          onClick={() => setUserPickerOpen(true)}
          style={{
            ...FIELD, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8,
            fontWeight: filters.user ? 700 : 400, minWidth: 110, justifyContent: "space-between",
          }}
        >
          <span>
            {filters.user
              ? (members.find(m => m.userId === filters.user)?.name || filters.user.slice(0, 8))
              : "全部成员"}
          </span>
          {filters.user ? (
            <span
              onClick={e => { e.stopPropagation(); applyFilter({ user: "" }); }}
              title="清除成员筛选"
              style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1 }}
            >
              ×
            </span>
          ) : (
            <span style={{ color: "var(--muted)", fontSize: 9 }}>▾</span>
          )}
        </button>
        <select value={filters.type} onChange={e => applyFilter({ type: e.target.value })} style={FIELD}>
          <option value="">全部资源类型</option>
          {resourceTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filters.source} onChange={e => applyFilter({ source: e.target.value })} style={FIELD}>
          <option value="">全部来源</option>
          {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={filters.status} onChange={e => applyFilter({ status: e.target.value })} style={FIELD}>
          <option value="">全部状态</option>
          <option value="active">有效</option>
          <option value="revoked">已撤销</option>
          <option value="expired">已过期</option>
        </select>
      </div>

      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

      {/* 账本表格 */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: "10px 22px 22px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["成员", "权限节点", "来源", "授予人", "创建时间", "过期", "状态", canRevoke ? "" : null].filter(h => h !== null).map(h => (
                <th key={h as string} style={{ textAlign: "left", padding: "10px 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ opacity: r.status === "active" ? 1 : 0.62 }}>
                <td style={{ padding: "8px", borderBottom: "1px solid var(--line)", fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap" }}>
                  {r.userName || r.userId.slice(0, 8)}
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid var(--line)" }}>
                  <code style={{ fontSize: 11, color: "var(--ink)" }}>{nodeKey(r)}</code>
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                  <Badge tone={r.grantSource === "approval" ? "blue" : r.grantSource === "auto" ? "neutral" : "amber"}>
                    {SOURCE_LABEL[r.grantSource] ?? r.grantSource}
                  </Badge>
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid var(--line)", color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {r.confirmedByName ?? (r.grantSource === "auto" ? "系统" : "—")}
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid var(--line)", color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {fmtTime(r.createdAt)}
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid var(--line)", color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {r.expiresAt ? fmtTime(r.expiresAt) : "长期"}
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                  {r.status === "active" && <Badge tone="green">有效</Badge>}
                  {r.status === "expired" && <Badge tone="neutral">已过期</Badge>}
                  {r.status === "revoked" && (
                    <Badge tone="red">{REASON_LABEL[r.revokedReason ?? ""] ?? "已撤销"}</Badge>
                  )}
                </td>
                {canRevoke && (
                  <td style={{ padding: "8px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                    {r.status === "active" && (
                      <button
                        disabled={busy}
                        onClick={() => revoke(r)}
                        style={{ ...SECONDARY_BTN, padding: "3px 9px", fontSize: 10, borderColor: "var(--danger)", color: "var(--danger)" }}
                      >
                        撤销
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p style={{ padding: "30px 0", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>无匹配流水</p>
        )}
        {rows.length < total && (
          <div style={{ textAlign: "center", marginTop: 14 }}>
            <button style={SECONDARY_BTN} disabled={busy} onClick={() => load(filters, rows.length)}>
              加载更多（{rows.length} / {total}）
            </button>
          </div>
        )}
      </section>

      {userPickerOpen && (
        <MemberPickerModal
          kicker="合规"
          title="按成员筛选流水"
          single
          members={members}
          depts={depts}
          busy={busy}
          onClose={() => setUserPickerOpen(false)}
          onConfirm={([userId]) => {
            applyFilter({ user: userId });
            setUserPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
