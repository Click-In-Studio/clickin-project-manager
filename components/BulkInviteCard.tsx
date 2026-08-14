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

type ParsedRow = {
  name: string;
  roles: string[];
  unknownRoles: string[];
  deptIds: string[];
  unknownDepts: string[];
  email: string | null;
  feishuOpenId: string | null;
  category: "registered" | "feishu_only" | "email_only" | "none";
  userId: string | null;
  alreadyMember: boolean;
};

type ParseStats = { registered: number; alreadyMember: number; feishuOnly: number; emailOnly: number; none: number };

const CATEGORY_LABEL: Record<ParsedRow["category"], [string, "green" | "blue" | "amber" | "red" | "neutral"]> = {
  registered: ["已注册", "green"],
  feishu_only: ["飞书可达", "blue"],
  email_only: ["邮箱可达", "amber"],
  none: ["无渠道", "red"],
};

/** 批量邀请（#156，数据迁移页）：飞书表格识别分发 / 粘贴邮箱列表。替代原直接导入。 */
export default function BulkInviteCard({ productionId, roleNames, depts }: Props) {
  const [mode, setMode] = useState<"sheet" | "paste">("sheet");
  const [wikiUrl, setWikiUrl] = useState("");
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [parseStats, setParseStats] = useState<ParseStats | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [makeClaimLink, setMakeClaimLink] = useState(true);
  const [sheetResult, setSheetResult] = useState<Record<string, unknown> | null>(null);
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

  async function parseSheet() {
    setBusy(true); setError(null); setParsed(null); setParseStats(null); setSheetResult(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/invites/parse-table`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wikiUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setError([data.error, ...(data.details ?? [])].filter(Boolean).join("；"));
        return;
      }
      setParsed(data.rows ?? []);
      setParseStats(data.stats ?? null);
      setParseWarnings(data.warnings ?? []);
    } catch { setError("网络错误"); }
    finally { setBusy(false); }
  }

  async function sendSheet() {
    if (!parsed) return;
    setBusy(true); setError(null); setSheetResult(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/invites/table-send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed, makeClaimLink }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "发送失败"); return; }
      setSheetResult(data);
      if (data.claimUrl) {
        await navigator.clipboard.writeText(data.claimUrl as string).catch(() => {});
      }
    } catch { setError("网络错误"); }
    finally { setBusy(false); }
  }

  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "6px 0", borderRadius: 7, border: "none", cursor: "pointer",
    fontSize: 12, fontWeight: 700,
    background: active ? "var(--ink)" : "transparent",
    color: active ? "#fff" : "var(--muted)",
  });

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, marginBottom: 18 }}>
      <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>
        Bulk Invite
      </p>
      <h3 style={{ margin: "0 0 6px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>
        批量邀请成员
      </h3>
      <div style={{ display: "flex", gap: 4, padding: 4, background: "var(--surface-2)", borderRadius: 9, marginBottom: 12, maxWidth: 360 }}>
        <button style={segBtn(mode === "sheet")} onClick={() => setMode("sheet")}>飞书表格</button>
        <button style={segBtn(mode === "paste")} onClick={() => setMode("paste")}>粘贴邮箱</button>
      </div>

      {mode === "sheet" && (
        <div>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
            粘贴飞书多维表格 Wiki 链接（列约定：姓名·必 / 职位·必·多选 / 邮箱 / 人员 / 部门）。
            识别后按身份分发：已注册走站内通知（默认通道），未注册飞书用户发 bot 私信（有邮箱再补邮件），
            仅邮箱发邀请邮件；无任何渠道的可生成按名字认领的批量链接。
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input
              value={wikiUrl} onChange={e => setWikiUrl(e.target.value)}
              placeholder="https://xxx.feishu.cn/wiki/…"
              style={{ flex: 1, padding: "9px 11px", fontSize: 13, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}
            />
            <button style={SECONDARY_BTN} disabled={busy || !wikiUrl.trim()} onClick={parseSheet}>
              {busy && !parsed ? "识别中…" : "识别表格"}
            </button>
          </div>

          {parseStats && parsed && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                <Badge tone="green">已注册 {parseStats.registered}</Badge>
                <Badge tone="blue">飞书可达 {parseStats.feishuOnly}</Badge>
                <Badge tone="amber">仅邮箱 {parseStats.emailOnly}</Badge>
                <Badge tone="red">无渠道 {parseStats.none}</Badge>
                {parseStats.alreadyMember > 0 && <Badge tone="neutral">已是成员 {parseStats.alreadyMember}</Badge>}
              </div>
              <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10, padding: 8, background: "var(--paper)" }}>
                {parsed.map((r, i) => {
                  const [label, tone] = CATEGORY_LABEL[r.category];
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", borderBottom: "1px solid var(--line)" }}>
                      <span style={{ minWidth: 70, fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>{r.name}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[r.roles.join("·"), r.deptIds.map(id => depts.find(d => d.id === id)?.name).filter(Boolean).join("·"), r.email ?? ""].filter(Boolean).join("  ")}
                      </span>
                      {r.unknownRoles.length > 0 && <Badge tone="red">未知职位</Badge>}
                      {r.unknownDepts.length > 0 && <Badge tone="red">未知部门</Badge>}
                      {r.alreadyMember ? <Badge tone="neutral">已是成员</Badge> : <Badge tone={tone}>{label}</Badge>}
                    </div>
                  );
                })}
              </div>
              {parseWarnings.length > 0 && (
                <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--danger)" }}>{parseWarnings.join("；")}</p>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                {parseStats.none > 0 && (
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink)", cursor: "pointer" }}>
                    <input type="checkbox" checked={makeClaimLink} onChange={e => setMakeClaimLink(e.target.checked)} />
                    为 {parseStats.none} 名无渠道人员生成认领链接
                  </label>
                )}
                <button style={{ ...PRIMARY_BTN, marginLeft: "auto" }} disabled={busy} onClick={sendSheet}>
                  {busy ? "发送中…" : "发送邀请"}
                </button>
              </div>
            </div>
          )}

          {sheetResult && (
            <div style={{ fontSize: 12, lineHeight: 1.8 }}>
              <p style={{ margin: 0, fontWeight: 700, color: "var(--success)" }}>
                站内通知 {String(sheetResult.notified)} · 飞书私信 {String(sheetResult.feishuSent)} · 邮件 {String(sheetResult.emailSent)}
                {Array.isArray(sheetResult.skippedMembers) && sheetResult.skippedMembers.length > 0 && ` · 跳过已是成员 ${sheetResult.skippedMembers.length}`}
              </p>
              {Array.isArray(sheetResult.noChannel) && sheetResult.noChannel.length > 0 && !sheetResult.claimUrl && (
                <p style={{ margin: 0, color: "var(--danger)" }}>无渠道未发送：{(sheetResult.noChannel as string[]).join("、")}</p>
              )}
              {typeof sheetResult.claimUrl === "string" && (
                <p style={{ margin: 0, color: "var(--ink)" }}>
                  认领链接（{String(sheetResult.claimCount)} 人，已复制）：<code style={{ fontSize: 11 }}>{sheetResult.claimUrl}</code>
                </p>
              )}
              {Array.isArray(sheetResult.failures) && sheetResult.failures.length > 0 && (
                <p style={{ margin: 0, color: "var(--danger)" }}>{(sheetResult.failures as string[]).join("；")}</p>
              )}
            </div>
          )}
        </div>
      )}

      {mode === "paste" && (
      <div>
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
      </div>
      )}

      {error && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

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
