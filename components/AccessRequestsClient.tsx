"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "@/components/my-pages.module.css";
import type { ApprovalRequest } from "@/lib/db";

// ─── Constants ────────────────────────────────────────────────────────────────

type ResourceOption = { type: string; label: string; levels: { value: string; label: string }[] };

const RESOURCE_OPTIONS: ResourceOption[] = [
  {
    type: "cue_list",
    label: "Cue表",
    levels: [
      { value: "view",   label: "查看" },
      { value: "mount",  label: "挂载" },
      { value: "edit",   label: "编辑" },
      { value: "manage", label: "管理" },
    ],
  },
  {
    type: "scene",
    label: "章节/段落",
    levels: [
      { value: "view",   label: "查看" },
      { value: "mount",  label: "挂载" },
      { value: "edit",   label: "编辑" },
      { value: "manage", label: "管理" },
    ],
  },
  {
    type: "event",
    label: "事件",
    levels: [
      { value: "view",    label: "查看" },
      { value: "edit",    label: "编辑" },
      { value: "publish", label: "发布" },
      { value: "manage",  label: "管理" },
    ],
  },
];

const STATUS_LABELS: Record<ApprovalRequest["status"], string> = {
  pending_supervisor: "等待直属上级",
  pending_resource:   "等待资源负责人",
  approved:           "已批准",
  rejected:           "已拒绝",
  cancelled:          "已撤回",
};

type StatusColor = "amber" | "green" | "red" | "muted";

function statusColor(s: ApprovalRequest["status"]): StatusColor {
  if (s === "pending_supervisor" || s === "pending_resource") return "amber";
  if (s === "approved")  return "green";
  if (s === "rejected")  return "red";
  return "muted";
}

function resourceLabel(req: ApprovalRequest) {
  const opt = RESOURCE_OPTIONS.find((o) => o.type === req.resourceType);
  const typeLabel  = opt?.label ?? req.resourceType ?? "—";
  const levelLabel = opt?.levels.find((l) => l.value === req.permissionLevel)?.label ?? req.permissionLevel ?? "—";
  return `${typeLabel} · ${levelLabel}`;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400_000);
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d >= todayStart)     return `今天 ${hhmm}`;
  if (d >= yesterdayStart) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────

const BADGE_CLASS: Record<StatusColor, string> = {
  amber: styles.badgeAmber,
  green: styles.badgeGreen,
  red:   styles.badgeRed,
  muted: "",
};

function StatusBadge({ status }: { status: ApprovalRequest["status"] }) {
  const col = statusColor(status);
  return (
    <span
      className={BADGE_CLASS[col]}
      style={col === "muted" ? {
        fontSize: 11, padding: "2px 8px", borderRadius: 999, fontWeight: 600,
        background: "var(--surface-2)", color: "var(--muted)",
      } : { fontSize: 11, padding: "2px 8px", borderRadius: 999, fontWeight: 600 }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

// ─── RequestForm ──────────────────────────────────────────────────────────────

function RequestForm({ productionId, onSubmitted, onClose }: {
  productionId: string;
  onSubmitted: () => void;
  onClose: () => void;
}) {
  const [resourceType, setResourceType]       = useState(RESOURCE_OPTIONS[0].type);
  const [permissionLevel, setPermissionLevel] = useState(RESOURCE_OPTIONS[0].levels[0].value);
  const [grantType, setGrantType]             = useState<"permanent" | "ttl">("permanent");
  const [note, setNote]                       = useState("");
  const [submitting, setSubmitting]           = useState(false);
  const [error, setError]                     = useState<string | null>(null);

  const currentResource = RESOURCE_OPTIONS.find((o) => o.type === resourceType) ?? RESOURCE_OPTIONS[0];

  function handleResourceChange(type: string) {
    setResourceType(type);
    const opt = RESOURCE_OPTIONS.find((o) => o.type === type);
    if (opt) setPermissionLevel(opt.levels[0].value);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/production/${productionId}/access-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceType, permissionLevel, grantType, note: note.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "提交失败");
      }
      onSubmitted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    fontSize: 13, padding: "6px 10px", borderRadius: 6,
    border: "1px solid var(--line)", background: "var(--paper)",
    color: "var(--ink)", width: "100%", boxSizing: "border-box",
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500, color: "var(--ink)" }}>申请资源权限</h2>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>资源类型</label>
        <select value={resourceType} onChange={(e) => handleResourceChange(e.target.value)} style={fieldStyle}>
          {RESOURCE_OPTIONS.map((o) => <option key={o.type} value={o.type}>{o.label}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>权限等级</label>
        <select value={permissionLevel} onChange={(e) => setPermissionLevel(e.target.value)} style={fieldStyle}>
          {currentResource.levels.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", gap: 16 }}>
        {(["permanent", "ttl"] as const).map((v) => (
          <label key={v} style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="radio" name="grantType" value={v} checked={grantType === v} onChange={() => setGrantType(v)} />
            {v === "permanent" ? "永久" : "临时"}
          </label>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>申请理由（选填）</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="说明你需要此权限的原因…"
          style={{ ...fieldStyle, resize: "vertical" }}
        />
      </div>

      {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger, #ef4444)" }}>{error}</p>}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="primary-btn" style={{ fontSize: 13 }} disabled={submitting}>
          {submitting ? "提交中…" : "提交申请"}
        </button>
        <button type="button" className="secondary-btn" style={{ fontSize: 13 }} onClick={onClose}>
          取消
        </button>
      </div>
    </form>
  );
}

// ─── RequestDetail ────────────────────────────────────────────────────────────

function RequestDetail({ req, canAct, onApprove, onReject, onCancel, acting }: {
  req: ApprovalRequest;
  canAct?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  onCancel?: () => void;
  acting?: boolean;
}) {
  const label = resourceLabel(req);
  const isPending = req.status === "pending_supervisor" || req.status === "pending_resource";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Meta badges */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusBadge status={req.status} />
        {req.grantType === "ttl" && (
          <span style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 999, fontWeight: 600,
            background: "var(--surface-2)", color: "var(--muted)",
          }}>临时权限</span>
        )}
      </div>

      {/* Title */}
      <h2 style={{
        margin: 0,
        fontFamily: 'Georgia, "Noto Serif SC", serif',
        fontSize: "clamp(18px, 2vw, 22px)", fontWeight: 500, color: "var(--ink)", lineHeight: 1.3,
      }}>
        {label}
        {req.resourceId && req.resourceId !== "*" && (
          <span style={{ fontSize: 14, fontWeight: 400, color: "var(--muted)", marginLeft: 6 }}>
            （{req.resourceId}）
          </span>
        )}
      </h2>

      <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
        申请于 {fmtDate(req.createdAt)}
        {req.ttlDuration && <span style={{ marginLeft: 8 }}>· 时效 {req.ttlDuration}</span>}
      </p>

      {/* Note */}
      {req.note && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--muted)", fontWeight: 500 }}>申请理由</p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{req.note}</p>
        </div>
      )}

      {/* Actions */}
      {isPending && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, display: "flex", gap: 8 }}>
          {canAct ? (
            <>
              <button className="primary-btn" style={{ fontSize: 13 }} disabled={acting} onClick={onApprove}>批准</button>
              <button className="secondary-btn" style={{ fontSize: 13 }} disabled={acting} onClick={onReject}>拒绝</button>
            </>
          ) : (
            <button className="secondary-btn" style={{ fontSize: 13 }} disabled={acting} onClick={onCancel}>撤回申请</button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

type Tab = "mine" | "pending";
type RightPanel = { type: "form" } | { type: "detail"; req: ApprovalRequest; canAct: boolean } | null;

interface Props {
  productionId: string;
  productionName: string;
}

export default function AccessRequestsClient({ productionId, productionName }: Props) {
  const [tab, setTab]                         = useState<Tab>("mine");
  const [myRequests, setMyRequests]           = useState<ApprovalRequest[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [loadingMine, setLoadingMine]         = useState(true);
  const [loadingPending, setLoadingPending]   = useState(true);
  const [acting, setActing]                   = useState<string | null>(null);
  const [rightPanel, setRightPanel]           = useState<RightPanel>(null);

  // Mobile accordion
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);

  const fetchMine = useCallback(async () => {
    setLoadingMine(true);
    try {
      const res = await fetch(`/api/production/${productionId}/access-requests`);
      if (!res.ok) return;
      const data = (await res.json()) as { requests: ApprovalRequest[] };
      setMyRequests(data.requests);
    } finally {
      setLoadingMine(false);
    }
  }, [productionId]);

  const fetchPending = useCallback(async () => {
    setLoadingPending(true);
    try {
      const res = await fetch(`/api/production/${productionId}/pending-approvals`);
      if (!res.ok) return;
      const data = (await res.json()) as { approvals: ApprovalRequest[] };
      setPendingApprovals(data.approvals);
    } finally {
      setLoadingPending(false);
    }
  }, [productionId]);

  useEffect(() => { void fetchMine(); void fetchPending(); }, [fetchMine, fetchPending]);

  // Keep right panel in sync when data refreshes
  useEffect(() => {
    if (!rightPanel || rightPanel.type === "form") return;
    const list = rightPanel.canAct ? pendingApprovals : myRequests;
    const updated = list.find((r) => r.id === rightPanel.req.id);
    if (updated) setRightPanel({ type: "detail", req: updated, canAct: rightPanel.canAct });
  }, [myRequests, pendingApprovals]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApprove(reqId: string) {
    setActing(reqId);
    try {
      const res = await fetch(`/api/production/${productionId}/access-requests/${reqId}/approve`, { method: "POST" });
      if (res.ok) await Promise.all([fetchMine(), fetchPending()]);
    } finally { setActing(null); }
  }

  async function handleReject(reqId: string) {
    setActing(reqId);
    try {
      const res = await fetch(`/api/production/${productionId}/access-requests/${reqId}/reject`, { method: "POST" });
      if (res.ok) await Promise.all([fetchMine(), fetchPending()]);
    } finally { setActing(null); }
  }

  async function handleCancel(reqId: string) {
    setActing(reqId);
    try {
      const res = await fetch(`/api/production/${productionId}/access-requests/${reqId}/cancel`, { method: "POST" });
      if (res.ok) { await fetchMine(); setRightPanel(null); }
    } finally { setActing(null); }
  }

  const pendingCount = pendingApprovals.length;
  const currentList = tab === "mine" ? myRequests : pendingApprovals;
  const isLoading   = tab === "mine" ? loadingMine : loadingPending;

  function selectRequest(req: ApprovalRequest, canAct: boolean) {
    setRightPanel({ type: "detail", req, canAct });
  }

  function openForm() {
    setRightPanel({ type: "form" });
  }

  // ── Desktop list item ─────────────────────────────────────────────────────
  function renderListItem(req: ApprovalRequest, canAct: boolean) {
    const col = statusColor(req.status);
    const isSelected = rightPanel?.type === "detail" && rightPanel.req.id === req.id;
    const dotColor = col === "amber"
      ? "var(--stage)" : col === "green"
      ? "var(--success, #22c55e)" : col === "red"
      ? "var(--danger, #ef4444)" : "var(--line)";

    return (
      <button
        key={req.id}
        onClick={() => selectRequest(req, canAct)}
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
          background: isSelected ? "rgba(255,255,255,.4)" : dotColor,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            margin: "0 0 3px", fontSize: 13, fontWeight: 500,
            color: isSelected ? "#fff" : "var(--ink)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {resourceLabel(req)}
          </p>
          <p style={{ margin: 0, fontSize: 11, color: isSelected ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
            {STATUS_LABELS[req.status]} · {fmtDate(req.createdAt)}
          </p>
        </div>
      </button>
    );
  }

  // ── Mobile card ────────────────────────────────────────────────────────────
  function renderMobileCard(req: ApprovalRequest, canAct: boolean) {
    const isExpanded = mobileExpanded === req.id;
    const col = statusColor(req.status);
    const cardMod = col === "amber" ? styles.warn : col === "red" ? styles.danger : col === "green" ? styles.info : "";

    return (
      <div key={req.id} className={`${styles.mobileCard} ${cardMod}`}>
        <button
          className={styles.mobileCardBtn}
          onClick={() => setMobileExpanded(isExpanded ? null : req.id)}
        >
          <div className={styles.mobileCardHeader}>
            <span className={styles.mobileCardProduction}>{STATUS_LABELS[req.status]}</span>
            <span className={styles.mobileCardTime}>{fmtDate(req.createdAt)}</span>
          </div>
          <p className={`${styles.mobileCardTitle} ${isExpanded ? "" : styles.mobileCardTitleClamp}`}>
            {resourceLabel(req)}
          </p>
          {!isExpanded && req.note && (
            <p className={styles.mobileCardPreview}>{req.note}</p>
          )}
        </button>
        {isExpanded && (
          <div className={styles.mobileCardDetail}>
            {req.note && (
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{req.note}</p>
            )}
            {(req.status === "pending_supervisor" || req.status === "pending_resource") && (
              <div style={{ display: "flex", gap: 8 }}>
                {canAct ? (
                  <>
                    <button className="primary-btn" style={{ fontSize: 12 }} disabled={acting === req.id} onClick={() => void handleApprove(req.id)}>批准</button>
                    <button className="secondary-btn" style={{ fontSize: 12 }} disabled={acting === req.id} onClick={() => void handleReject(req.id)}>拒绝</button>
                  </>
                ) : (
                  <button className="secondary-btn" style={{ fontSize: 12 }} disabled={acting === req.id} onClick={() => void handleCancel(req.id)}>撤回申请</button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "34px clamp(22px, 4vw, 62px) 72px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>{productionName}</p>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1 className={styles.pageTitle}>资源申请</h1>
          {pendingCount > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
              background: "var(--stage)", color: "#fff",
            }}>
              {pendingCount} 条待审批
            </span>
          )}
        </div>
      </div>

      {/* Tab strip */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--line)", marginBottom: 20 }}>
        {([
          ["mine",    "我的申请"] as const,
          ["pending", `待审批${pendingCount > 0 ? ` (${pendingCount})` : ""}`] as const,
        ]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => { setTab(t); setRightPanel(null); }}
            style={{
              background: "none", border: "none",
              borderBottom: tab === t ? "2px solid var(--ink)" : "2px solid transparent",
              padding: "8px 16px", fontSize: 13,
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? "var(--ink)" : "var(--muted)",
              cursor: "pointer", marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Mobile ── */}
      <div className={styles.mobileOnly}>
        {tab === "mine" && (
          <div style={{ marginBottom: 12 }}>
            <button className="primary-btn" style={{ fontSize: 13 }} onClick={() => setMobileExpanded("__form__")}>
              申请资源权限
            </button>
          </div>
        )}
        {tab === "mine" && mobileExpanded === "__form__" && (
          <div style={{
            border: "1px solid var(--line)", borderRadius: 10, padding: 16, marginBottom: 12,
            background: "var(--surface)",
          }}>
            <RequestForm
              productionId={productionId}
              onSubmitted={() => { void fetchMine(); }}
              onClose={() => setMobileExpanded(null)}
            />
          </div>
        )}
        {isLoading ? (
          <div className={styles.emptyState}>加载中…</div>
        ) : currentList.length === 0 ? (
          <div className={styles.emptyState}>
            {tab === "mine" ? "暂无申请记录" : "暂无待审批申请"}
            <small>{tab === "mine" ? "点击上方按钮发起申请" : "当前没有需要你审批的资源申请"}</small>
          </div>
        ) : (
          <div className={styles.mobileCardList}>
            {currentList.map((req) => renderMobileCard(req, tab === "pending"))}
          </div>
        )}
      </div>

      {/* ── Desktop ── */}
      <div className={styles.desktopOnly}>
        <div className={styles.splitLayout}>
          {/* Left: list */}
          <div className={`${styles.splitPane} ${styles.splitList}`}>
            {tab === "mine" && (
              <button
                onClick={openForm}
                style={{
                  border: "1px solid " + (rightPanel?.type === "form" ? "var(--ink)" : "var(--line)"),
                  borderRadius: 10, padding: "10px 14px",
                  background: rightPanel?.type === "form" ? "var(--ink)" : "transparent",
                  cursor: "pointer", textAlign: "left", width: "100%",
                  display: "flex", alignItems: "center", gap: 10,
                  color: rightPanel?.type === "form" ? "#fff" : "var(--muted)",
                  fontSize: 13, marginBottom: 8,
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
                申请资源权限
              </button>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 16 }}>
              {isLoading ? (
                <p style={{ fontSize: 13, color: "var(--muted)", padding: "12px 14px" }}>加载中…</p>
              ) : currentList.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--muted)", padding: "12px 14px" }}>
                  {tab === "mine" ? "暂无申请记录" : "暂无待审批申请"}
                </p>
              ) : (
                currentList.map((req) => renderListItem(req, tab === "pending"))
              )}
            </div>
          </div>

          {/* Right: detail / form */}
          <div className={`${styles.splitPane} ${styles.splitDetail}`}>
            {rightPanel?.type === "form" ? (
              <RequestForm
                productionId={productionId}
                onSubmitted={() => { void fetchMine(); }}
                onClose={() => setRightPanel(null)}
              />
            ) : rightPanel?.type === "detail" ? (
              <RequestDetail
                req={rightPanel.req}
                canAct={rightPanel.canAct}
                acting={acting === rightPanel.req.id}
                onApprove={() => void handleApprove(rightPanel.req.id)}
                onReject={() => void handleReject(rightPanel.req.id)}
                onCancel={() => void handleCancel(rightPanel.req.id)}
              />
            ) : (
              <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                {tab === "mine" ? "选择左侧申请查看详情，或点击「申请资源权限」发起新申请" : "选择左侧申请进行审批"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
