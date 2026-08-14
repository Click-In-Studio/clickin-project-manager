"use client";

import { useState } from "react";
import Badge from "@/components/Badge";
import TreePickerModal from "@/components/TreePickerModal";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import { BASE_PATH } from "@/lib/base-path";

type Dept = { id: string; name: string; parentId: string | null; kind: "dept" | "group" };

type Props = {
  productionId: string;
  roleNames: string[];
  depts: Dept[];
};

/** 批量邀请（#156，数据迁移页）：粘贴邮箱列表逐个发定向邀请，可统一预配角色/部门。 */
export default function BulkInviteCard({ productionId, roleNames, depts }: Props) {
  const [raw, setRaw] = useState("");
  const [presetRoles, setPresetRoles] = useState<string[]>([]);
  const [presetDeptIds, setPresetDeptIds] = useState<string[]>([]);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [deptPickerOpen, setDeptPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sent: number; failed: number; results: { email: string; ok: boolean; error?: string }[] } | null>(null);

  const emails = [...new Set(raw.split(/[\n,;，；\s]+/).map(e => e.trim().toLowerCase()).filter(Boolean))];

  async function send() {
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/invites`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "email", emails, presetRoles, presetDeptIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "发送失败"); return; }
      setResult({ sent: data.sent ?? 0, failed: data.failed ?? 0, results: data.results ?? [] });
      if ((data.failed ?? 0) === 0) setRaw("");
    } catch { setError("网络错误"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, marginBottom: 18 }}>
      <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>
        Bulk Invite
      </p>
      <h3 style={{ margin: "0 0 6px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>
        批量邀请成员
      </h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
        粘贴邮箱列表（换行/逗号/空格分隔，至多 100 个），将逐个发送定向邀请邮件（14 天有效）。
        对方登录/注册后自动入组，可统一预配角色与部门。
      </p>
      <textarea
        value={raw}
        onChange={e => setRaw(e.target.value)}
        placeholder={"alice@example.com\nbob@example.com"}
        rows={5}
        style={{
          width: "100%", padding: "10px 12px", fontSize: 13, fontFamily: "ui-monospace, monospace",
          border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)",
          resize: "vertical", boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", margin: "10px 0" }}>
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
        <span style={{ marginLeft: "auto", fontSize: 11, color: emails.length > 100 ? "var(--danger)" : "var(--muted)", fontWeight: 700 }}>
          {emails.length} 个邮箱
        </span>
        <button style={PRIMARY_BTN} disabled={busy || emails.length === 0 || emails.length > 100} onClick={send}>
          {busy ? "发送中…" : "发送邀请"}
        </button>
      </div>

      {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}
      {result && (
        <div style={{ fontSize: 12 }}>
          <p style={{ margin: "0 0 6px", fontWeight: 700, color: result.failed ? "var(--danger)" : "var(--success)" }}>
            成功 {result.sent} · 失败 {result.failed}
          </p>
          {result.results.filter(r => !r.ok).map(r => (
            <p key={r.email} style={{ margin: "2px 0", color: "var(--danger)" }}>{r.email}：{r.error}</p>
          ))}
        </div>
      )}

      {rolePickerOpen && (
        <TreePickerModal
          kicker="数据迁移" title="预配角色"
          items={roleNames.filter(r => r !== "制作人").map(r => ({ id: r, label: r }))}
          preselected={presetRoles}
          onClose={() => setRolePickerOpen(false)}
          onConfirm={(sel) => { setPresetRoles(sel); setRolePickerOpen(false); }}
        />
      )}
      {deptPickerOpen && (
        <TreePickerModal
          kicker="数据迁移" title="预配部门"
          items={depts.map(d => ({ id: d.id, label: d.name, parentId: d.parentId, badge: d.kind === "group" ? "组" : undefined }))}
          preselected={presetDeptIds}
          onClose={() => setDeptPickerOpen(false)}
          onConfirm={(sel) => { setPresetDeptIds(sel); setDeptPickerOpen(false); }}
        />
      )}
    </div>
  );
}
