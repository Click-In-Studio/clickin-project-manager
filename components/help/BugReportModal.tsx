"use client";

// 「报告问题」表单（#538）。两个入口共用：AppShell 头像菜单、手册文章页底部。
// 用户只填「哪类 / 发生了什么 / 怎么联系（选填）」，页面路径、项目、视口、浏览器由这里
// 自动带上——报告没有上下文，开发看了也复现不了。落点是 bug_report 日志表，不发通知。

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import AdminModal from "@/components/ui/AdminModal";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/ui/PageHeader";
import { BASE_PATH } from "@/lib/base-path";
import { extractProductionId } from "@/components/shell/app-shell/route";
import { BUG_REPORT_KINDS, BUG_REPORT_KIND_LABELS, BUG_REPORT_BODY_MAX, type BugReportKind } from "@/lib/help/bug-report-db";

export default function BugReportModal({ onClose, manualSlug, defaultKind = "bug" }: {
  onClose: () => void;
  /** 从手册页打开时带上页 slug，开发一眼知道是哪篇说的不对 */
  manualSlug?: string | null;
  defaultKind?: BugReportKind;
}) {
  const pathname = usePathname();
  const [kind, setKind] = useState<BugReportKind>(defaultKind);
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!body.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/bug-reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, body: body.trim(), contact: contact.trim() || null,
          pagePath: pathname, manualSlug: manualSlug ?? null,
          productionId: extractProductionId(pathname),
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
      if (!res.ok || !data.ok) { setError(data.error ?? "提交失败，请稍后再试"); return; }
      setDoneId(data.id ?? "");
    } catch { setError("网络错误，请稍后再试"); }
    finally { setBusy(false); }
  }

  const field: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid var(--line)", borderRadius: 8,
    padding: "9px 11px", fontSize: 13, background: "var(--paper)", color: "var(--ink)", outline: "none",
  };
  const label: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 700, color: "var(--muted)", margin: "0 0 6px", letterSpacing: ".04em" };

  if (doneId !== null) {
    return (
      <AdminModal kicker="Report" title="已收到" onClose={onClose} width={420}>
        <p style={{ margin: "0 0 18px", fontSize: 13, lineHeight: 1.7, color: "var(--ink)" }}>
          谢谢。我们会定期查看这些反馈，需要进一步了解时按你留的方式联系。
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" style={PRIMARY_BTN} onClick={onClose}>关闭</button>
        </div>
      </AdminModal>
    );
  }

  return (
    <AdminModal kicker="Report" title="报告问题" onClose={onClose} width={480}>
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <span style={label}>是哪类</span>
          <div role="radiogroup" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {BUG_REPORT_KINDS.map((k) => (
              <button
                key={k} type="button" role="radio" aria-checked={kind === k}
                onClick={() => setKind(k)}
                style={{
                  borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${kind === k ? "var(--ink)" : "var(--line)"}`,
                  background: kind === k ? "var(--ink)" : "transparent", color: kind === k ? "#fff" : "var(--ink)",
                }}
              >
                {BUG_REPORT_KIND_LABELS[k]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span style={label}>发生了什么</span>
          <textarea
            value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={BUG_REPORT_BODY_MAX}
            placeholder={kind === "manual" ? "哪一段写的和实际不一样？实际是怎样的？" : "做了什么、看到了什么、期望是什么。能贴上出错的提示文字最好。"}
            style={{ ...field, resize: "vertical", lineHeight: 1.6 }}
            autoFocus
          />
        </div>
        <div>
          <span style={label}>怎么联系你（选填）</span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="飞书 / 邮箱 / 电话，方便追问时用" style={field} maxLength={200} />
        </div>
        <p style={{ margin: 0, fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
          会一并带上当前页面地址{manualSlug ? "、手册页" : ""}、窗口大小和浏览器信息，不含页面内容。
        </p>
        {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)", fontWeight: 600 }}>{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" style={SECONDARY_BTN} onClick={onClose}>取消</button>
          <button type="button" style={{ ...PRIMARY_BTN, opacity: !body.trim() || busy ? 0.5 : 1 }} disabled={!body.trim() || busy} onClick={submit}>
            {busy ? "提交中…" : "提交"}
          </button>
        </div>
      </div>
    </AdminModal>
  );
}
