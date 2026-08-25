"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import PageHeader, { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import styles from "@/components/my-pages.module.css";
import type { ApprovalPerson, ApprovalRequest } from "@/lib/db";
import { TTL_OPTIONS, displayTtlLabel, type TtlOptionValue } from "@/lib/approval-ttl";
import { buildApprovalTimeline, type TimelineNode, type TimelineNodeState } from "@/lib/approval-timeline";
import { APPROVAL_STAGE_LABELS, STAGE_ORDER } from "@/lib/approval-stages";

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

// 阶梯级名与动作词不在这里抄第二份：lib/approval-stages.ts 是前后端共用的唯一来源
// （此前页面上叫「资源持有人」，飞书通知里叫「资源持有者」，就是各抄一份的结果）。
// 节点文案由 buildApprovalTimeline 组装，见 lib/approval-timeline.ts。

/**
 * 表单里那句「依次匹配 …」由阶梯序生成，不手写——手写的那版漏了「上级部门负责人」，
 * 而且后端加一级它也不会跟着变。
 *
 * 这仍然只是**规则说明**，不是这条申请的真实链路：真链路要走 preview 接口现算。
 */
const LADDER_TEXT = STAGE_ORDER.map((s) => APPROVAL_STAGE_LABELS[s]).join("、");

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

// ─── ApprovalFlow ────────────────────────────────────────────────────────────

function initials(name: string) {
  const clean = name.trim();
  return clean ? clean.slice(-2) : "成员";
}

function PersonChip({ userId, person, fallbackName }: {
  userId: string;
  person?: ApprovalPerson;
  fallbackName?: string;
}) {
  const name = person?.name || fallbackName || "项目成员";
  const role = person?.roles?.[0];
  return (
    <span
      title={person ? `${name}${person.roles.length ? ` · ${person.roles.join("、")}` : ""}` : userId}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, minHeight: 28,
        padding: "3px 9px 3px 4px", border: "1px solid var(--line)", borderRadius: 999,
        background: "var(--paper)", color: "var(--ink)", fontSize: 11, fontWeight: 600,
      }}
    >
      <span style={{
        width: 20, height: 20, borderRadius: "50%", display: "grid", placeItems: "center",
        background: "var(--surface-2)", color: "var(--muted)", fontSize: 8, flexShrink: 0,
      }}>
        {initials(name)}
      </span>
      <span>{name}</span>
      {role && <small style={{ color: "var(--muted)", fontSize: 9, fontWeight: 500 }}>{role}</small>}
    </span>
  );
}

/** 节点状态 → 圆点颜色。terminated 是灰的，但它是「没处理」不是「还在等」——差别写在文案里。 */
function dotColorOf(state: TimelineNodeState): string {
  if (state === "current")    return "var(--stage)";
  if (state === "rejected")   return "var(--danger, #ef4444)";
  if (state === "terminated") return "var(--line)";
  return "var(--success, #4b7f65)";
}

function ApprovalFlow({ req, compact = false }: {
  req: ApprovalRequest;
  compact?: boolean;
}) {
  const isPending = req.status === "pending_supervisor" || req.status === "pending_resource";
  // 时间线的组装逻辑（含超时、撤回、被顶掉、存量无链等降级分支）在 lib/approval-timeline.ts，
  // 由 tests/approval-timeline.test.ts 覆盖——这些状态在页面上极难手工复现。
  const nodes: TimelineNode[] = useMemo(() => buildApprovalTimeline(req), [req]);
  // 姓名与角色随审批 DTO 一起下来（people），不再联查通讯录：那条路拉全员邮箱手机号
  // 只为取个名，还覆盖不到不在成员名单里的审批人（祖先部门 POC、存量演出 owner）。
  const personOf = (userId: string) => req.people[userId];

  return (
    <section style={{ borderTop: "1px solid var(--line)", paddingTop: compact ? 14 : 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>审批流程</h3>
        <span style={{ fontSize: 9, fontWeight: 700, color: "var(--stage)", background: "#f2e4d9", borderRadius: 999, padding: "3px 8px" }}>
          审批
        </span>
      </div>

      <div>
        {nodes.map((node, index) => {
          const isLast = index === nodes.length - 1;
          const dotColor = dotColorOf(node.state);
          return (
            <div key={node.key} style={{ display: "grid", gridTemplateColumns: "18px minmax(0, 1fr)", gap: 11 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <span style={{
                  width: 9, height: 9, marginTop: 4, borderRadius: "50%", flexShrink: 0,
                  background: dotColor, boxShadow: node.state === "current" ? "0 0 0 4px #f2e4d9" : "none",
                }} />
                {!isLast && <span style={{ width: 1, flex: 1, minHeight: compact ? 42 : 50, background: "var(--line)", marginTop: 5 }} />}
              </div>
              <div style={{ paddingBottom: isLast ? 0 : compact ? 13 : 17, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "var(--muted)", letterSpacing: ".08em" }}>{node.kind}</span>
                  <b style={{ fontSize: 12, color: "var(--ink)" }}>{node.title}</b>
                  {node.actionLabel && <small style={{ fontSize: 10, color: dotColor }}>{node.actionLabel}</small>}
                  {node.state === "current" && <small style={{ fontSize: 10, color: "var(--stage)" }}>当前节点</small>}
                  <time style={{ marginLeft: "auto", fontSize: 9, color: "var(--muted)" }}>{fmtDate(node.time)}</time>
                </div>
                {node.expiresAt !== undefined && (
                  <p style={{ margin: "6px 0 0", fontSize: 10, color: "var(--muted)" }}>
                    {node.expiresAt ? `有效期至 ${fmtDate(node.expiresAt)}` : "长期有效"}
                  </p>
                )}
                {node.people.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {node.people.map((userId) => (
                      <PersonChip key={userId} userId={userId} person={personOf(userId)} />
                    ))}
                  </div>
                )}
                {/* 或签：同一级任一人处理即完成，不写清楚会被读成需要全员批准 */}
                {node.anyOneOf && (
                  <p style={{ margin: "5px 0 0", fontSize: 10, color: "var(--muted)" }}>
                    任一人处理即可
                  </p>
                )}
                {/* 「原因」独立于「操作人」渲染：超时自动升级恒无操作人，
                    挂在操作人下面会让最该说清楚的那句话永远显示不出来。 */}
                {(node.actorId || node.bySystem || node.reason) && (
                  <p style={{ margin: "6px 0 0", fontSize: 10, color: "var(--muted)" }}>
                    {node.actorId
                      ? `由 ${personOf(node.actorId)?.name || "项目成员"} 操作`
                      : node.bySystem ? "系统自动处理" : null}
                    {node.actorId && node.reason ? " · " : ""}
                    {!node.actorId && node.bySystem && node.reason ? " · " : ""}
                    {node.reason}
                  </p>
                )}
                {node.comment && (
                  <p style={{
                    margin: "6px 0 0", padding: "6px 9px", borderRadius: 6,
                    background: "var(--paper)", color: "var(--ink)", fontSize: 11, lineHeight: 1.5,
                  }}>
                    {node.comment}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {isPending && (
        <p style={{ margin: "12px 0 0 29px", padding: "9px 11px", borderRadius: 8, background: "var(--paper)", color: "var(--muted)", fontSize: 10, lineHeight: 1.55 }}>
          后续审批人会依据届时的汇报关系、资源负责人和制作团队配置动态计算。
        </p>
      )}
    </section>
  );
}

function ApprovalFlowPreview() {
  return (
    <section style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>审批流程</h3>
      <div style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success, #4b7f65)", marginTop: 4 }} />
          <span style={{ width: 1, minHeight: 34, flex: 1, background: "var(--line)", margin: "5px 0" }} />
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--stage)" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
          <div>
            <small style={{ fontSize: 9, color: "var(--muted)", fontWeight: 700 }}>发起</small>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--ink)", fontWeight: 600 }}>你提交申请</p>
          </div>
          <div>
            <small style={{ fontSize: 9, color: "var(--stage)", fontWeight: 700 }}>审批</small>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--ink)", fontWeight: 600 }}>系统匹配审批链路</p>
            <p style={{ margin: "4px 0 0", fontSize: 10, lineHeight: 1.55, color: "var(--muted)" }}>
              依次匹配{LADDER_TEXT}；无对应人员的节点自动跳过。
            </p>
          </div>
        </div>
      </div>
    </section>
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
  const [ttlOption, setTtlOption]             = useState<TtlOptionValue>("permanent");
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
      // #256：选「临时」必须连时长一起发。只发 grantType 的话服务端算不出
      // expires_at，批准后拿到的是永久权限，与页面显示的「临时」正相反。
      const res = await fetch(`/api/production/${productionId}/access-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceType,
          permissionLevel,
          grantType: ttlOption === "permanent" ? "permanent" : "ttl",
          ttlDuration: TTL_OPTIONS.find((o) => o.value === ttlOption)?.interval ?? null,
          note: note.trim() || null,
        }),
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


      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>有效期</label>
        {/* 档位只能来自 lib/approval-ttl 的 TTL_OPTIONS——服务端按同一份表白名单校验，
            页面自己硬编码天数会被 400 挡掉（#256 的成因，见该文件顶部注释）。 */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${TTL_OPTIONS.length}, minmax(0, 1fr))`, gap: 7 }}>
          {TTL_OPTIONS.map((o) => {
            const active = ttlOption === o.value;
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={active}
                onClick={() => setTtlOption(o.value)}
                style={{
                  border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
                  borderRadius: 8,
                  padding: "9px 4px",
                  background: active ? "var(--ink)" : "var(--paper)",
                  color: active ? "#fff" : "var(--muted)",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {ttlOption !== "permanent" && (
          <small style={{ fontSize: 10, color: "var(--muted)" }}>
            审批通过后开始计时，到期将自动失效。
          </small>
        )}
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

      <ApprovalFlowPreview />

      {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger, #ef4444)" }}>{error}</p>}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" style={{ ...PRIMARY_BTN, fontSize: 13 }} disabled={submitting}>
          {submitting ? "提交中…" : "提交申请"}
        </button>
        <button type="button" style={{ ...SECONDARY_BTN, fontSize: 13 }} onClick={onClose}>
          取消
        </button>
      </div>
    </form>
  );
}

// ─── RequestDetail ────────────────────────────────────────────────────────────

function RequestDetail({ req, canAct, onApprove, onReject, onEscalate, onCancel, acting }: {
  req: ApprovalRequest;
  canAct?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  onEscalate?: () => void;
  onCancel?: () => void;
  acting?: boolean;
}) {
  const label = resourceLabel(req);
  const isPending = req.status === "pending_supervisor" || req.status === "pending_resource";
  // #140：canFinalize === false = 我是直属上级但本人没有这个权限，只能向上转交
  const forwardOnly = canAct && req.canFinalize === false;
  const ttlLabel = displayTtlLabel(req.ttlDurationLabel);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Meta badges */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusBadge status={req.status} />
        {req.grantType === "ttl" && (
          <span style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 999, fontWeight: 600,
            background: "var(--surface-2)", color: "var(--muted)",
          }}>临时权限{ttlLabel ? ` · ${ttlLabel}` : ""}</span>
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

      {req.subjectName && (
        <p style={{ margin: "-8px 0 0", fontSize: 12, color: "var(--muted)" }}>
          申请人：<b style={{ color: "var(--ink)" }}>{req.subjectName}</b>
        </p>
      )}

      <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
        申请于 {fmtDate(req.createdAt)}
        {ttlLabel && <span style={{ marginLeft: 8 }}>· 时效 {ttlLabel}</span>}
      </p>

      {/* Note */}
      {req.note && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--muted)", fontWeight: 500 }}>申请理由</p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{req.note}</p>
        </div>
      )}

      <ApprovalFlow req={req} />

      {/* Actions */}
      {isPending && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {forwardOnly && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
              你本人尚未持有该权限，无法批准，只能向上转交给下一级审批人。
            </p>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {canAct ? (
              <>
                {forwardOnly ? (
                  <button style={{ ...PRIMARY_BTN, fontSize: 13 }} disabled={acting} onClick={onEscalate}>向上转交</button>
                ) : (
                  <button style={{ ...PRIMARY_BTN, fontSize: 13 }} disabled={acting} onClick={onApprove}>批准</button>
                )}
                <button style={{ ...SECONDARY_BTN, fontSize: 13 }} disabled={acting} onClick={onReject}>拒绝</button>
                {!forwardOnly && (
                  <button style={{ ...SECONDARY_BTN, fontSize: 13 }} disabled={acting} onClick={onEscalate}>向上转交</button>
                )}
              </>
            ) : (
              <button style={{ ...SECONDARY_BTN, fontSize: 13 }} disabled={acting} onClick={onCancel}>撤回申请</button>
            )}
          </div>
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
  const [actionError, setActionError]         = useState<string | null>(null);
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

  // 通讯录联查已退役：姓名与角色随审批 DTO 的 people 一起下来（#324）。
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
    setActionError(null);
    try {
      const res = await fetch(`/api/production/${productionId}/access-requests/${reqId}/approve`, { method: "POST" });
      if (res.ok) {
        await Promise.all([fetchMine(), fetchPending()]);
      } else {
        // forward_only（只能转交）等服务端判定要显示出来，否则按钮像是没反应
        const data = await res.json().catch(() => ({}));
        setActionError((data as { error?: string }).error ?? "审批失败");
        await fetchPending();
      }
    } finally { setActing(null); }
  }

  /** #140：转交到审批阶梯的下一级——不是拒绝，链路完整记在 escalation_chain。 */
  async function handleEscalate(reqId: string) {
    setActing(reqId);
    setActionError(null);
    try {
      const res = await fetch(`/api/production/${productionId}/access-requests/${reqId}/escalate`, { method: "POST" });
      if (res.ok) {
        await Promise.all([fetchMine(), fetchPending()]);
        setRightPanel(null);
      } else {
        const data = await res.json().catch(() => ({}));
        setActionError((data as { error?: string }).error ?? "转交失败");
      }
    } finally { setActing(null); }
  }

  async function handleReject(reqId: string) {
    setActing(reqId);
    setActionError(null);
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
            {canAct && req.subjectName ? `${req.subjectName} · ` : ""}{resourceLabel(req)}
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
            {req.canFinalize === false && canAct && (
              <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                你本人尚未持有该权限，只能向上转交。
              </p>
            )}
            <ApprovalFlow req={req} compact />
            {actionError && acting !== req.id && (
              <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--danger, #ef4444)" }}>{actionError}</p>
            )}
            {(req.status === "pending_supervisor" || req.status === "pending_resource") && (
              <div style={{ display: "flex", gap: 8 }}>
                {canAct ? (
                  <>
                    {req.canFinalize === false ? (
                      <button style={{ ...PRIMARY_BTN, fontSize: 12, padding: "7px 12px" }} disabled={acting === req.id} onClick={() => void handleEscalate(req.id)}>向上转交</button>
                    ) : (
                      <button style={{ ...PRIMARY_BTN, fontSize: 12, padding: "7px 12px" }} disabled={acting === req.id} onClick={() => void handleApprove(req.id)}>批准</button>
                    )}
                    <button style={{ ...SECONDARY_BTN, fontSize: 12, padding: "7px 12px" }} disabled={acting === req.id} onClick={() => void handleReject(req.id)}>拒绝</button>
                  </>
                ) : (
                  <button style={{ ...SECONDARY_BTN, fontSize: 12, padding: "7px 12px" }} disabled={acting === req.id} onClick={() => void handleCancel(req.id)}>撤回申请</button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Header（v3 统一页头） */}
      <PageHeader
        eyebrow={productionName}
        title={
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 12 }}>
            资源申请
            {pendingCount > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                background: "var(--stage)", color: "#fff", fontFamily: "system-ui, sans-serif",
              }}>
                {pendingCount} 条待审批
              </span>
            )}
          </span>
        }
        side="stage"
      />

      {/* ── 摘要统计（通知页同款语汇）── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(pendingCount), "待我审批", "需要你的决定"],
          [String(myRequests.filter(r => r.status === "pending_supervisor" || r.status === "pending_resource").length), "我的进行中", "等待审批人处理"],
          [String(myRequests.filter(r => r.status === "approved").length), "已批准", "我的申请获准记录"],
        ].map(([num, label, hint]) => (
          <div key={label} style={{
            minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13,
            background: "var(--surface)",
          }}>
            <span style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28, color: "var(--ink)" }}>{num}</span>
            <p style={{ margin: 0, display: "flex", flexDirection: "column" }}>
              <b style={{ fontSize: 11, color: "var(--ink)" }}>{label}</b>
              <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 9 }}>{hint}</small>
            </p>
          </div>
        ))}
      </div>

      {/* ── Panel（通知页同款）：tab + 分栏 ── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column" }}>
      {/* Tab strip */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--line)", marginBottom: 20 }}>
        {([
          ["mine",    "我的申请"] as const,
          ["pending", `待审批${pendingCount > 0 ? ` (${pendingCount})` : ""}`] as const,
        ]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => { setTab(t); setRightPanel(null); setActionError(null); }}
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
            <button style={{ ...PRIMARY_BTN, fontSize: 13 }} onClick={() => setMobileExpanded("__form__")}>
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
      <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
        <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
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
              <>
                <RequestDetail
                  req={rightPanel.req}
                  canAct={rightPanel.canAct}
                  acting={acting === rightPanel.req.id}
                  onApprove={() => void handleApprove(rightPanel.req.id)}
                  onReject={() => void handleReject(rightPanel.req.id)}
                  onEscalate={() => void handleEscalate(rightPanel.req.id)}
                  onCancel={() => void handleCancel(rightPanel.req.id)}
                />
                {actionError && (
                  <p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--danger, #ef4444)" }}>{actionError}</p>
                )}
              </>
            ) : (
              <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                {tab === "mine" ? "选择左侧申请查看详情，或点击「申请资源权限」发起新申请" : "选择左侧申请进行审批"}
              </div>
            )}
          </div>
        </div>
      </div>
      </section>
    </div>
  );
}
