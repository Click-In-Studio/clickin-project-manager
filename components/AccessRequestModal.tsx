"use client";

import { useState, useEffect } from "react";

// ─── Labels ───────────────────────────────────────────────────────────────────

export const PERMISSION_LABELS: Record<string, string> = {
  "event:view":          "查看日程",
  "event:edit":          "编辑日程",
  "event:publish":       "发布日程",
  "event:manage":        "管理日程",
};

// ─── Resource selector options (free-form mode only) ─────────────────────────

export type ResourceOption = {
  type: string;
  label: string;
  levels: { value: string; label: string }[];
};

export const RESOURCE_OPTIONS: ResourceOption[] = [
  {
    type: "cue_list",
    label: "Cue 表",
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
      { value: "edit",   label: "编辑" },
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
  {
    type: "script",
    label: "剧本",
    levels: [
      { value: "view",   label: "查看" },
      { value: "edit",   label: "编辑" },
    ],
  },
  {
    type: "character",
    label: "角色",
    levels: [
      { value: "view",   label: "查看" },
    ],
  },
  {
    type: "member",
    label: "人员通讯录",
    levels: [
      { value: "view",   label: "查看" },
    ],
  },
  {
    type: "asset",
    label: "附件",
    levels: [
      { value: "view",     label: "查看" },
      { value: "edit",     label: "编辑" },
    ],
  },
  {
    type: "task",
    label: "任务",
    levels: [
      { value: "view", label: "查看" },
    ],
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

type Props = {
  open: boolean;
  onClose: () => void;
  productionId: string;
  /**
   * Atomic permission key that caused the 403 (e.g. ).
   * When set: the form is locked to this permission — user only fills in a reason.
   * When unset: free-form mode with resource type / level selectors.
   */
  permission?: string;
  /** 预填申请理由（如 AI 调用触发的固定文案）——预填但仍可编辑，不锁死。 */
  initialNote?: string;
  onSubmitted?: () => void;
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--line)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

export default function AccessRequestModal({
  open,
  onClose,
  productionId,
  permission,
  initialNote,
  onSubmitted,
}: Props) {
  // Free-form mode state (only used when permission is NOT set)
  const [resourceType,    setResourceType]    = useState(RESOURCE_OPTIONS[0].type);
  const [permissionLevel, setPermissionLevel] = useState(RESOURCE_OPTIONS[0].levels[0].value);

  const [ttlOption,  setTtlOption]  = useState<"permanent" | "30m" | "1h" | "1d" | "1w">("permanent");
  const [note,       setNote]       = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [done,       setDone]       = useState(false);

  useEffect(() => {
    if (!open) return;
    setResourceType(RESOURCE_OPTIONS[0].type);
    setPermissionLevel(RESOURCE_OPTIONS[0].levels[0].value);
    setTtlOption("permanent");
    setNote(initialNote ?? "");
    setError(null);
    setDone(false);
    setSubmitting(false);
  }, [open, initialNote]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  // ── Resolve resource type + level for POST body ──────────────────────────
  // 终局（批G）：预填一律为 node: 节点键（403 redirect 已节点化）——解析为
  // resource_access + sub/verb 提交；atomic_permission 类型已随原子键退役。
  let postResourceType: string;
  let postResourceId = "*";
  let postResourceSub: string | undefined;
  let postPermissionLevel: string;
  const nodeMatch = permission
    ? /^node:([^/]+)\/([^/@]+)(?:\/(.+))?@(\w+)$/.exec(permission)
    : null;
  if (nodeMatch) {
    postResourceType = nodeMatch[1];
    postResourceId = nodeMatch[2];
    postResourceSub = nodeMatch[3];
    postPermissionLevel = nodeMatch[4];
  } else {
    postResourceType    = resourceType;
    postPermissionLevel = permissionLevel;
  }

  const currentOpt = RESOURCE_OPTIONS.find((o) => o.type === resourceType) ?? RESOURCE_OPTIONS[0];

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
          type: "resource_access",
          resourceType: postResourceType,
          resourceId: postResourceId,
          resourceSub: postResourceSub,
          permissionLevel: postPermissionLevel,
          grantType: ttlOption === "permanent" ? "permanent" : "ttl",
          ttlDuration: ({ "30m": "30 minutes", "1h": "1 hour", "1d": "1 day", "1w": "7 days" } as Record<string, string>)[ttlOption] ?? null,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "提交失败");
      }
      setDone(true);
      onSubmitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  const NODE_LABELS: Record<string, string> = {
    "node:scene/*/meta@view": "查看章节/段落",
    "node:script/*/blocks@view": "查看剧本",
    "node:character/*/meta@view": "查看角色",
    "node:member/*/meta@view": "查看人员通讯录",
    "node:asset/*/meta@view": "查看附件",
    "node:task/*/meta@view": "查看任务",
    "node:event/*/meta@view": "查看事件",
  };
  // 实例级 node 键（node:task/<id>/*@edit）精确表匹配不到 → 按 type+verb 通用取名
  const NODE_TYPE_LABELS: Record<string, string> = {
    task: "任务", event: "事件", cue_list: "Cue 表", scene: "章节/段落",
    character: "角色", script: "剧本", asset: "附件", member: "人员",
    report: "报告", note: "备注", dept: "部门", production: "项目", wiki: "文档",
  };
  const NODE_VERB_LABELS: Record<string, string> = {
    view: "查看", edit: "编辑", create: "创建", delete: "删除", manage: "管理", "*": "全部操作",
  };
  const genericNodeLabel = nodeMatch
    ? `${NODE_VERB_LABELS[nodeMatch[4]] ?? nodeMatch[4]}${NODE_TYPE_LABELS[nodeMatch[1]] ?? nodeMatch[1]}${nodeMatch[2] !== "*" ? "（单个）" : ""}`
    : null;
  const permLabel = permission
    ? (NODE_LABELS[permission] ?? PERMISSION_LABELS[permission] ?? genericNodeLabel ?? permission)
    : null;

  return (
    <div
      role="presentation"
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "0 16px",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-req-title"
        style={{
          width: "min(440px, 100%)",
          background: "var(--surface)",
          borderRadius: 16,
          boxShadow: "0 24px 80px rgba(24,42,42,.22)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "24px 28px 18px",
          borderBottom: "1px solid var(--line)",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        }}>
          <div>
            <p style={{
              margin: "0 0 3px", fontSize: 9, fontWeight: 700,
              letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)",
            }}>
              ACCESS REQUEST
            </p>
            <h2 id="access-req-title" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)" }}>
              申请权限
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--muted)", fontSize: 18, lineHeight: 1, padding: 4, marginTop: 2,
            }}
          >
            ✕
          </button>
        </div>

        {done ? (
          /* Success */
          <div style={{ padding: "32px 28px", textAlign: "center" }}>
            <p style={{ fontSize: 32, margin: "0 0 12px" }}>✓</p>
            <p style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>申请已提交</p>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
              已通知相关审批人，批准后你将收到通知。
            </p>
            <button
              onClick={onClose}
              style={{
                padding: "9px 28px", borderRadius: 9,
                background: "var(--ink)", color: "var(--paper)",
                fontSize: 13, fontWeight: 600,
                border: "none", cursor: "pointer", fontFamily: "inherit",
              }}
            >
              知道了
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 14 }}>

              {/* ── Locked mode: show what's being requested ── */}
              {permLabel ? (
                <div style={{
                  padding: "12px 14px",
                  background: "var(--surface-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                }}>
                  <p style={{ margin: "0 0 3px", fontSize: 11, color: "var(--muted)", fontWeight: 500 }}>
                    申请权限
                  </p>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)", overflowWrap: "anywhere" }}>
                    {permLabel}
                    {permLabel !== permission && (
                      <span style={{
                        marginLeft: 8, fontFamily: "monospace", fontSize: 11,
                        color: "var(--muted)", fontWeight: 400,
                        overflowWrap: "anywhere", wordBreak: "break-all",
                      }}>
                        {permission}
                      </span>
                    )}
                  </p>
                </div>
              ) : (
                /* ── Free-form mode: resource type + level selectors ── */
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>资源类型</label>
                    <select
                      value={resourceType}
                      onChange={(e) => handleResourceChange(e.target.value)}
                      style={fieldStyle}
                    >
                      {RESOURCE_OPTIONS.map((o) => (
                        <option key={o.type} value={o.type}>{o.label}</option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>权限级别</label>
                    <select
                      value={permissionLevel}
                      onChange={(e) => setPermissionLevel(e.target.value)}
                      style={fieldStyle}
                    >
                      {currentOpt.levels.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>有效期</label>
                <select
                  value={ttlOption}
                  onChange={(e) => setTtlOption(e.target.value as typeof ttlOption)}
                  style={fieldStyle}
                >
                  <option value="permanent">长期</option>
                  <option value="30m">30 分钟</option>
                  <option value="1h">1 小时</option>
                  <option value="1d">1 天</option>
                  <option value="1w">1 周</option>
                </select>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>
                  申请理由{permission ? "" : "（选填）"}
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="说明申请原因，有助于审批人快速批准"
                  rows={3}
                  style={{ ...fieldStyle, resize: "vertical" }}
                />
              </div>

              {error && (
                <p style={{ margin: 0, fontSize: 12, color: "#c0392b" }}>{error}</p>
              )}
            </div>

            <div style={{ padding: "0 28px 24px", display: "flex", gap: 10 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={{
                  flex: 1, padding: "10px 0", borderRadius: 10,
                  border: "1px solid var(--line)", background: "transparent",
                  fontSize: 13, color: "var(--muted)",
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                style={{
                  flex: 2, padding: "10px 0", borderRadius: 10,
                  border: "none", background: "var(--ink)",
                  fontSize: 13, fontWeight: 600, color: "var(--paper)",
                  cursor: submitting ? "wait" : "pointer",
                  opacity: submitting ? 0.6 : 1,
                  fontFamily: "inherit",
                }}
              >
                {submitting ? "提交中…" : "提交申请"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
