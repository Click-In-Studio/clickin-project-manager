"use client";

import { useEffect, useState } from "react";
import AdminModal from "@/components/AdminModal";
import Badge from "@/components/Badge";
import TreePickerModal from "@/components/TreePickerModal";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import { BASE_PATH } from "@/lib/base-path";
import type { InviteRow } from "@/lib/invite-db";

type Dept = { id: string; name: string; parentId: string | null; kind: "dept" | "group" };

type Props = {
  productionId: string;
  roleNames: string[];
  depts: Dept[];
  onClose: () => void;
};

const FIELD: React.CSSProperties = {
  padding: "9px 11px", fontSize: 13, border: "1px solid var(--line)", borderRadius: 8,
  background: "var(--paper)", color: "var(--ink)",
};

const STATUS_BADGE: Record<InviteRow["status"], [string, "green" | "red" | "neutral"]> = {
  active: ["有效", "green"],
  revoked: ["已撤销", "red"],
  expired: ["已过期", "neutral"],
  exhausted: ["次数用完", "neutral"],
};

/** 邀请 modal：单个邮件邀请 + 邀请链接管理（批量邀请在「数据迁移」页）。 */
export default function InviteModal({ productionId, roleNames, depts, onClose }: Props) {
  const [tab, setTab] = useState<"email" | "link">("email");
  const [email, setEmail] = useState("");
  const [presetRoles, setPresetRoles] = useState<string[]>([]);
  const [presetDeptIds, setPresetDeptIds] = useState<string[]>([]);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [deptPickerOpen, setDeptPickerOpen] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [maxUses, setMaxUses] = useState<number | "">("");
  const [invites, setInvites] = useState<InviteRow[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/invites`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.invites)) setInvites(d.invites); })
      .catch(() => {});
  }, [productionId]);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/invites`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "操作失败"); return null; }
      return data;
    } catch { setError("网络错误"); return null; }
    finally { setBusy(false); }
  }

  async function refresh() {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/invites`);
    const d = await res.json().catch(() => ({}));
    if (Array.isArray(d.invites)) setInvites(d.invites);
  }

  async function sendEmailInvite() {
    const data = await post({ kind: "email", emails: [email], presetRoles, presetDeptIds });
    if (data) {
      setMsg(`已向 ${email} 发送邀请邮件（14 天有效）`);
      setEmail("");
      refresh();
    }
  }

  async function createLink() {
    const data = await post({
      kind: "link", expiresInDays,
      maxUses: maxUses === "" ? null : maxUses,
      presetRoles, presetDeptIds,
    });
    if (data?.url) {
      await navigator.clipboard.writeText(data.url as string).catch(() => {});
      setMsg("链接已生成并复制到剪贴板");
      refresh();
    }
  }

  async function revoke(token: string) {
    if (!confirm("确认撤销该邀请？")) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/invites`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  function copyLink(token: string) {
    const url = `${window.location.origin}${BASE_PATH}/invite/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(token);
      setTimeout(() => setCopied(null), 1500);
    }).catch(() => {});
  }

  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "6px 0", borderRadius: 7, border: "none", cursor: "pointer",
    fontSize: 12, fontWeight: 700,
    background: active ? "var(--ink)" : "transparent",
    color: active ? "#fff" : "var(--muted)",
  });

  const presetSummary = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>预配：</span>
      {presetRoles.map(r => <Badge key={r} tone="blue">{r}</Badge>)}
      {presetDeptIds.map(id => {
        const d = depts.find(x => x.id === id);
        return d ? <Badge key={id} tone="neutral">{d.name}</Badge> : null;
      })}
      {presetRoles.length === 0 && presetDeptIds.length === 0 && (
        <span style={{ fontSize: 11, color: "var(--muted)" }}>（零角色入组）</span>
      )}
      <button style={{ ...SECONDARY_BTN, padding: "2px 8px", fontSize: 10 }} onClick={() => setRolePickerOpen(true)}>角色</button>
      <button style={{ ...SECONDARY_BTN, padding: "2px 8px", fontSize: 10 }} onClick={() => setDeptPickerOpen(true)}>部门</button>
    </div>
  );

  return (
    <AdminModal kicker="组织架构" title="邀请成员" onClose={onClose} width={560}>
      <div style={{ display: "flex", gap: 4, padding: 4, background: "var(--surface-2)", borderRadius: 9, marginBottom: 14 }}>
        <button style={segBtn(tab === "email")} onClick={() => setTab("email")}>邮件邀请</button>
        <button style={segBtn(tab === "link")} onClick={() => setTab("link")}>邀请链接</button>
      </div>

      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}
      {msg && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--success)", fontWeight: 700 }}>{msg}</p>}

      {tab === "email" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={email} onChange={e => setEmail(e.target.value)} placeholder="邮箱地址"
            autoFocus type="email" style={FIELD}
            onKeyDown={e => { if (e.key === "Enter" && email.trim()) sendEmailInvite(); }}
          />
          {presetSummary}
          <p style={{ margin: 0, fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
            定向邀请（仅该邮箱账号可用，14 天有效）。对方已注册则登录后加入，未注册则注册后自动加入。批量邀请在「数据迁移」页。
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button style={PRIMARY_BTN} disabled={busy || !email.trim()} onClick={sendEmailInvite}>发送邀请</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>有效期</label>
            <select value={expiresInDays} onChange={e => setExpiresInDays(Number(e.target.value))} style={FIELD}>
              <option value={1}>1 天</option>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
            </select>
            <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>次数上限</label>
            <input
              value={maxUses}
              onChange={e => setMaxUses(e.target.value === "" ? "" : Math.max(1, Number(e.target.value) || 1))}
              placeholder="不限" type="number" min={1} style={{ ...FIELD, width: 90 }}
            />
          </div>
          {presetSummary}
          <p style={{ margin: 0, fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
            任何拿到链接的人登录/注册后即可加入本项目——请仅在可信渠道分发，可随时在下方撤销。
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button style={PRIMARY_BTN} disabled={busy} onClick={createLink}>生成链接并复制</button>
          </div>
        </div>
      )}

      {/* 邀请列表 */}
      <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
        <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>
          已发出的邀请（{invites?.length ?? "…"}）
        </p>
        <div style={{ maxHeight: "30vh", overflowY: "auto" }}>
          {(invites ?? []).map(inv => {
            const [label, tone] = STATUS_BADGE[inv.status];
            return (
              <div key={inv.token} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {inv.email ?? "开放链接"}
                  <span style={{ color: "var(--muted)", fontSize: 10 }}>
                    {"  "}已用 {inv.usedCount}{inv.maxUses ? `/${inv.maxUses}` : ""} 次
                    {inv.expiresAt ? ` · ${new Date(inv.expiresAt).getMonth() + 1}/${new Date(inv.expiresAt).getDate()} 过期` : ""}
                  </span>
                </span>
                <Badge tone={tone}>{label}</Badge>
                {inv.status === "active" && !inv.email && (
                  <button style={{ ...SECONDARY_BTN, padding: "2px 8px", fontSize: 10 }} onClick={() => copyLink(inv.token)}>
                    {copied === inv.token ? "已复制" : "复制"}
                  </button>
                )}
                {inv.status === "active" && (
                  <button
                    style={{ ...SECONDARY_BTN, padding: "2px 8px", fontSize: 10, borderColor: "var(--danger)", color: "var(--danger)" }}
                    disabled={busy} onClick={() => revoke(inv.token)}
                  >
                    撤销
                  </button>
                )}
              </div>
            );
          })}
          {invites && invites.length === 0 && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>暂无邀请</p>
          )}
        </div>
      </div>

      {rolePickerOpen && (
        <TreePickerModal
          kicker="组织架构" title="预配角色"
          items={roleNames.filter(r => r !== "制作人").map(r => ({ id: r, label: r }))}
          preselected={presetRoles}
          onClose={() => setRolePickerOpen(false)}
          onConfirm={(sel) => { setPresetRoles(sel); setRolePickerOpen(false); }}
        />
      )}
      {deptPickerOpen && (
        <TreePickerModal
          kicker="组织架构" title="预配部门"
          items={depts.map(d => ({ id: d.id, label: d.name, parentId: d.parentId, badge: d.kind === "group" ? "组" : undefined }))}
          preselected={presetDeptIds}
          onClose={() => setDeptPickerOpen(false)}
          onConfirm={(sel) => { setPresetDeptIds(sel); setDeptPickerOpen(false); }}
        />
      )}
    </AdminModal>
  );
}
