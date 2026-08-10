"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "@/components/my-pages.module.css";
import type { ApprovalRequest } from "@/lib/db";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "mine" | "pending";

type ResourceOption = { type: string; label: string; levels: { value: string; label: string }[] };

const RESOURCE_OPTIONS: ResourceOption[] = [
  {
    type: "cue_list",
    label: "走位表",
    levels: [
      { value: "view", label: "查看" },
      { value: "mount", label: "挂接" },
      { value: "edit", label: "编辑" },
      { value: "manage", label: "管理" },
    ],
  },
  {
    type: "scene",
    label: "场景",
    levels: [
      { value: "view", label: "查看" },
      { value: "mount", label: "挂接" },
      { value: "edit", label: "编辑" },
      { value: "manage", label: "管理" },
    ],
  },
  {
    type: "event",
    label: "演出场次",
    levels: [
      { value: "view", label: "查看" },
      { value: "edit", label: "编辑" },
      { value: "publish", label: "发布" },
      { value: "manage", label: "管理" },
    ],
  },
];

const STATUS_LABELS: Record<ApprovalRequest["status"], string> = {
  pending_supervisor: "等待直属上级",
  pending_resource:  "等待资源负责人",
  approved:          "已批准",
  rejected:          "已拒绝",
  cancelled:         "已撤回",
};

const STATUS_COLORS: Record<ApprovalRequest["status"], string> = {
  pending_supervisor: "var(--warning, #f59e0b)",
  pending_resource:   "var(--warning, #f59e0b)",
  approved:           "var(--success, #22c55e)",
  rejected:           "var(--danger, #ef4444)",
  cancelled:          "var(--muted)",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ApprovalRequest["status"] }) {
  return (
    <span style={{
      fontSize: 11,
      padding: "2px 7px",
      borderRadius: 4,
      background: STATUS_COLORS[status] + "22",
      color: STATUS_COLORS[status],
      fontWeight: 500,
      whiteSpace: "nowrap",
    }}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function RequestCard({
  req,
  canAct,
  onApprove,
  onReject,
  onCancel,
  acting,
}: {
  req: ApprovalRequest;
  canAct?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  onCancel?: () => void;
  acting?: boolean;
}) {
  const resourceLabel =
    RESOURCE_OPTIONS.find((o) => o.type === req.resourceType)?.label ?? req.resourceType ?? "—";
  const levelLabel =
    RESOURCE_OPTIONS.find((o) => o.type === req.resourceType)
      ?.levels.find((l) => l.value === req.permissionLevel)?.label ?? req.permissionLevel ?? "—";

  return (
    <div style={{
      border: "1px solid var(--line)",
      borderRadius: 8,
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>
          {resourceLabel} · {levelLabel}
          {req.resourceId && req.resourceId !== "*" && (
            <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12, marginLeft: 4 }}>
              （{req.resourceId}）
            </span>
          )}
        </div>
        <StatusBadge status={req.status} />
      </div>
      {req.note && (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>{req.note}</div>
      )}
      <div style={{ fontSize: 11, color: "var(--muted)" }}>
        {new Date(req.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        {req.grantType === "ttl" && req.ttlDuration && (
          <span style={{ marginLeft: 8 }}>时效: {req.ttlDuration}</span>
        )}
      </div>
      {canAct && (req.status === "pending_supervisor" || req.status === "pending_resource") && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            className="primary-btn"
            style={{ fontSize: 12, padding: "4px 12px" }}
            disabled={acting}
            onClick={onApprove}
          >
            批准
          </button>
          <button
            className="secondary-btn"
            style={{ fontSize: 12, padding: "4px 12px" }}
            disabled={acting}
            onClick={onReject}
          >
            拒绝
          </button>
        </div>
      )}
      {!canAct && (req.status === "pending_supervisor" || req.status === "pending_resource") && onCancel && (
        <div style={{ marginTop: 4 }}>
          <button
            className="secondary-btn"
            style={{ fontSize: 12, padding: "4px 12px" }}
            disabled={acting}
            onClick={onCancel}
          >
            撤回申请
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Request Form ─────────────────────────────────────────────────────────────

function RequestForm({ productionId, onSubmitted }: { productionId: string; onSubmitted: () => void }) {
  const [open, setOpen] = useState(false);
  const [resourceType, setResourceType] = useState(RESOURCE_OPTIONS[0].type);
  const [permissionLevel, setPermissionLevel] = useState(RESOURCE_OPTIONS[0].levels[0].value);
  const [grantType, setGrantType] = useState<"permanent" | "ttl">("permanent");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        body: JSON.stringify({
          resourceType,
          permissionLevel,
          grantType,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "提交失败");
      }
      setOpen(false);
      setNote("");
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button className="primary-btn" style={{ fontSize: 13 }} onClick={() => setOpen(true)}>
        申请资源权限
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{
      border: "1px solid var(--line)",
      borderRadius: 8,
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}>
      <div style={{ fontWeight: 500, fontSize: 14 }}>新建资源访问申请</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>资源类型</label>
        <select
          value={resourceType}
          onChange={(e) => handleResourceChange(e.target.value)}
          style={{ fontSize: 13, padding: "5px 8px", borderRadius: 4, border: "1px solid var(--line)" }}
        >
          {RESOURCE_OPTIONS.map((o) => (
            <option key={o.type} value={o.type}>{o.label}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>权限等级</label>
        <select
          value={permissionLevel}
          onChange={(e) => setPermissionLevel(e.target.value)}
          style={{ fontSize: 13, padding: "5px 8px", borderRadius: 4, border: "1px solid var(--line)" }}
        >
          {currentResource.levels.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="radio"
            name="grantType"
            value="permanent"
            checked={grantType === "permanent"}
            onChange={() => setGrantType("permanent")}
          />
          永久
        </label>
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="radio"
            name="grantType"
            value="ttl"
            checked={grantType === "ttl"}
            onChange={() => setGrantType("ttl")}
          />
          临时
        </label>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>申请理由（选填）</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          style={{ fontSize: 13, padding: "5px 8px", borderRadius: 4, border: "1px solid var(--line)", resize: "vertical" }}
          placeholder="说明你需要此权限的原因…"
        />
      </div>

      {error && <div style={{ fontSize: 12, color: "var(--danger, #ef4444)" }}>{error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="primary-btn" style={{ fontSize: 12 }} disabled={submitting}>
          {submitting ? "提交中…" : "提交申请"}
        </button>
        <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </form>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface Props {
  productionId: string;
}

export default function AccessRequestsClient({ productionId }: Props) {
  const [tab, setTab] = useState<Tab>("mine");
  const [myRequests, setMyRequests] = useState<ApprovalRequest[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [loadingMine, setLoadingMine] = useState(true);
  const [loadingPending, setLoadingPending] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

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

  useEffect(() => {
    void fetchMine();
    void fetchPending();
  }, [fetchMine, fetchPending]);

  async function handleApprove(reqId: string) {
    setActing(reqId);
    try {
      const res = await fetch(
        `/api/production/${productionId}/access-requests/${reqId}/approve`,
        { method: "POST" },
      );
      if (res.ok) {
        await Promise.all([fetchMine(), fetchPending()]);
      }
    } finally {
      setActing(null);
    }
  }

  async function handleReject(reqId: string) {
    setActing(reqId);
    try {
      const res = await fetch(
        `/api/production/${productionId}/access-requests/${reqId}/reject`,
        { method: "POST" },
      );
      if (res.ok) {
        await Promise.all([fetchMine(), fetchPending()]);
      }
    } finally {
      setActing(null);
    }
  }

  async function handleCancel(reqId: string) {
    setActing(reqId);
    try {
      const res = await fetch(
        `/api/production/${productionId}/access-requests/${reqId}/cancel`,
        { method: "POST" },
      );
      if (res.ok) {
        await fetchMine();
      }
    } finally {
      setActing(null);
    }
  }

  const pendingCount = pendingApprovals.length;

  return (
    <div className={styles.pageRoot}>
      <div className={styles.header}>
        <h1 className={styles.title}>资源申请</h1>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--line)", marginBottom: 16 }}>
        {([["mine", "我的申请"], ["pending", `待审批${pendingCount > 0 ? ` (${pendingCount})` : ""}`]] as [Tab, string][]).map(
          ([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: "none",
                border: "none",
                borderBottom: tab === t ? "2px solid var(--stage)" : "2px solid transparent",
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: tab === t ? 600 : 400,
                color: tab === t ? "var(--stage)" : "var(--muted)",
                cursor: "pointer",
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          )
        )}
      </div>

      {/* ── Mine ── */}
      {tab === "mine" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <RequestForm productionId={productionId} onSubmitted={fetchMine} />
          {loadingMine ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>加载中…</div>
          ) : myRequests.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13, padding: "24px 0" }}>暂无申请记录</div>
          ) : (
            myRequests.map((req) => (
              <RequestCard
                key={req.id}
                req={req}
                onCancel={() => void handleCancel(req.id)}
                acting={acting === req.id}
              />
            ))
          )}
        </div>
      )}

      {/* ── Pending Approvals ── */}
      {tab === "pending" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {loadingPending ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>加载中…</div>
          ) : pendingApprovals.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13, padding: "24px 0" }}>暂无待审批申请</div>
          ) : (
            pendingApprovals.map((req) => (
              <RequestCard
                key={req.id}
                req={req}
                canAct
                onApprove={() => void handleApprove(req.id)}
                onReject={() => void handleReject(req.id)}
                acting={acting === req.id}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
