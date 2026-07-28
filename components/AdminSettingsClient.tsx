"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";

// ─── Section card wrapper ─────────────────────────────────────────────────────

function Section({ title, subtitle, children, danger }: {
  title: string; subtitle?: string; children: React.ReactNode; danger?: boolean;
}) {
  return (
    <div style={{
      background: "white", borderRadius: 12,
      border: danger ? "1px solid #fca5a5" : "1px solid var(--line)",
      padding: "20px 24px", marginBottom: 16,
    }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, color: danger ? "#dc2626" : "var(--ink)" }}>{title}</h2>
        {subtitle && <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function LockedNotice({ reason }: { reason: string }) {
  return (
    <p style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic", padding: "4px 0" }}>
      🔒 {reason}
    </p>
  );
}

// ─── 1. Rename ────────────────────────────────────────────────────────────────

function RenameSection({ productionId, initialName, canRename }: {
  productionId: string; initialName: string; canRename: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = name.trim() !== initialName && name.trim().length > 0;

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); }
    } finally { setSaving(false); }
  };

  return (
    <Section title="基本信息" subtitle="修改项目显示名称">
      {!canRename ? (
        <LockedNotice reason="需要 production:rename 权限（制作人 / 所有者）" />
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setSaved(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            placeholder="项目名称"
            style={{
              flex: 1, fontSize: 14, fontWeight: 500, color: "var(--ink)",
              background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8,
              padding: "8px 12px", outline: "none", boxSizing: "border-box",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--ink)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--line)"; }}
          />
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            style={{
              flexShrink: 0, fontSize: 13, fontWeight: 600,
              padding: "8px 16px", borderRadius: 8, border: "none",
              background: dirty ? "var(--ink)" : "var(--line)",
              color: dirty ? "white" : "var(--muted)",
              cursor: dirty ? "pointer" : "default", transition: "all .15s",
            }}
          >
            {saved ? "已保存 ✓" : saving ? "保存中…" : "保存"}
          </button>
        </div>
      )}
    </Section>
  );
}

// ─── 2. Import contacts ───────────────────────────────────────────────────────

function ImportContactsSection({ productionId, canImport }: {
  productionId: string; canImport: boolean;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleImport = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/import-contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wikiUrl: trimmed }),
      });
      const data = await res.json() as {
        ok?: boolean; stats?: { matched: number; created: number; notFound: string[] };
        error?: string; details?: string[];
      };
      if (res.ok && data.stats) {
        const { matched, created, notFound } = data.stats;
        const parts = [];
        if (matched) parts.push(`匹配 ${matched} 人`);
        if (created) parts.push(`新建 ${created} 人`);
        const msg = parts.length ? parts.join("，") : "无变化";
        const notFoundMsg = notFound.length ? `；${notFound.length} 人未找到：${notFound.slice(0, 5).join("、")}${notFound.length > 5 ? "…" : ""}` : "";
        setResult({ ok: true, message: `导入完成：${msg}${notFoundMsg}` });
        setUrl("");
      } else {
        setResult({ ok: false, message: data.error ?? "导入失败" });
      }
    } catch {
      setResult({ ok: false, message: "网络错误" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section title="批量导入人员" subtitle="从飞书多维表格同步通讯录（需要 contacts:import 权限）">
      {!canImport ? (
        <LockedNotice reason="需要 contacts:import 权限（制作人 / 所有者）" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <input
              value={url}
              onChange={(e) => { setUrl(e.target.value); setResult(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleImport(); }}
              placeholder="粘贴飞书多维表格 Wiki 链接…"
              style={{
                flex: 1, minWidth: 0, fontSize: 13, color: "var(--ink)",
                background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8,
                padding: "8px 12px", outline: "none", boxSizing: "border-box",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--ink)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--line)"; }}
            />
            <button
              onClick={handleImport}
              disabled={!url.trim() || loading}
              className="w-full sm:w-auto"
              style={{
                flexShrink: 0, fontSize: 13, fontWeight: 600, padding: "8px 16px",
                borderRadius: 8, border: "none", cursor: url.trim() ? "pointer" : "default",
                background: url.trim() ? "var(--script)" : "var(--line)",
                color: url.trim() ? "white" : "var(--muted)", transition: "all .15s",
              }}
            >
              {loading ? "导入中…" : "开始导入"}
            </button>
          </div>
          {result && (
            <p style={{ fontSize: 12, color: result.ok ? "#16a34a" : "#dc2626", padding: "2px 0" }}>
              {result.message}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

// ─── 3. Import script / scenes ────────────────────────────────────────────────

function ImportDataSection({ productionId, canScript, canScenes }: {
  productionId: string; canScript: boolean; canScenes: boolean;
}) {
  const items = [
    {
      label: "导入剧本",
      desc: "从飞书表格导入台词、角色、场景号等剧本数据",
      href: `/production/${productionId}/import-script`,
      can: canScript,
      lockMsg: "需要 script:import 权限",
    },
    {
      label: "导入构作",
      desc: "从飞书表格导入场次、梗概、时长等构作数据",
      href: `/production/${productionId}/import-scenes`,
      can: canScenes,
      lockMsg: "需要 dramaturgy:import 权限",
    },
  ];

  return (
    <Section title="数据导入" subtitle="从飞书表格导入结构化数据（会跳转至专属导入页面）">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((item) => (
          <div
            key={item.label}
            style={{
              display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
              padding: "12px 14px", borderRadius: 8, border: "1px solid var(--line)",
              background: "var(--paper)",
            }}
          >
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{item.label}</p>
              <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{item.desc}</p>
            </div>
            {item.can ? (
              <Link
                href={item.href}
                className="w-full sm:w-auto"
                style={{
                  flexShrink: 0, fontSize: 12, fontWeight: 600, padding: "6px 14px",
                  borderRadius: 7, border: "1px solid var(--ink)", color: "var(--ink)",
                  background: "white", textDecoration: "none", transition: "all .12s",
                  textAlign: "center",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--ink)"; e.currentTarget.style.color = "white"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "white"; e.currentTarget.style.color = "var(--ink)"; }}
              >
                前往导入 →
              </Link>
            ) : (
              <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>🔒 {item.lockMsg}</span>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── 4. Danger zone ───────────────────────────────────────────────────────────

function DangerSection({ productionId, productionName, isArchived, canArchive, canDelete }: {
  productionId: string; productionName: string;
  isArchived: boolean; canArchive: boolean; canDelete: boolean;
}) {
  const router = useRouter();
  const [archiving, setArchiving] = useState(false);
  const [archiveResult, setArchiveResult] = useState<string | null>(null);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [currentArchived, setCurrentArchived] = useState(isArchived);

  const handleArchive = async () => {
    const action = currentArchived ? "取消归档" : "归档";
    if (!confirm(`确定${action}项目「${productionName}」？`)) return;
    setArchiving(true);
    setArchiveResult(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/archive`, {
        method: currentArchived ? "DELETE" : "POST",
      });
      if (res.ok) {
        setCurrentArchived(!currentArchived);
        setArchiveResult(currentArchived ? "已取消归档" : "已归档");
      } else {
        const d = await res.json() as { error?: string };
        setArchiveResult(`失败：${d.error ?? "未知错误"}`);
      }
    } finally { setArchiving(false); }
  };

  const handleDelete = async () => {
    if (deleteInput !== productionName) return;
    if (!confirm(`⚠️ 最终确认：彻底删除项目「${productionName}」，所有数据将永久丢失，无法恢复。\n\n确认删除？`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/");
      } else {
        const d = await res.json() as { error?: string };
        alert(`删除失败：${d.error ?? "未知错误"}`);
        setDeleting(false);
      }
    } catch {
      alert("网络错误，删除失败");
      setDeleting(false);
    }
  };

  return (
    <Section title="敏感操作" subtitle="以下操作不可撤销或影响范围较大，请谨慎执行" danger>
      {/* Archive */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
              {currentArchived ? "取消归档" : "归档项目"}
            </p>
            <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {currentArchived
                ? "恢复项目为活跃状态，成员可继续编辑"
                : "将项目标记为归档，成员只读，项目不再出现在常用列表"}
            </p>
            {archiveResult && (
              <p style={{ fontSize: 11, color: "#16a34a", marginTop: 4 }}>{archiveResult}</p>
            )}
          </div>
          {!canArchive ? (
            <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", flexShrink: 0 }}>🔒 需要 production:archive</span>
          ) : (
            <button
              onClick={handleArchive}
              disabled={archiving}
              className="w-full sm:w-auto"
              style={{
                flexShrink: 0, fontSize: 13, fontWeight: 600, padding: "8px 16px",
                borderRadius: 8, border: "1px solid", cursor: "pointer",
                background: "white", transition: "all .15s",
                borderColor: currentArchived ? "#16a34a" : "#f97316",
                color: currentArchived ? "#16a34a" : "#f97316",
              }}
            >
              {archiving ? "处理中…" : currentArchived ? "取消归档" : "归档"}
            </button>
          )}
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "#fca5a5", marginBottom: 20 }} />

      {/* Delete */}
      <div>
        <p style={{ fontSize: 13, fontWeight: 600, color: "#dc2626" }}>删除项目</p>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, marginBottom: 12 }}>
          彻底删除项目及其所有数据（剧本、角色、Cue 表、事件、报告、附件等）。此操作不可撤销。
        </p>
        {!canDelete ? (
          <LockedNotice reason="仅项目所有者可删除（production:delete 权限）" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>
              输入项目名称 <strong style={{ color: "var(--ink)" }}>「{productionName}」</strong> 以确认：
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <input
                value={deleteInput}
                onChange={(e) => setDeleteInput(e.target.value)}
                placeholder={productionName}
                style={{
                  flex: 1, minWidth: 0, fontSize: 13, color: "var(--ink)",
                  background: "var(--paper)", border: "1px solid #fca5a5", borderRadius: 8,
                  padding: "8px 12px", outline: "none", boxSizing: "border-box",
                }}
              />
              <button
                onClick={handleDelete}
                disabled={deleteInput !== productionName || deleting}
                className="w-full sm:w-auto"
                style={{
                  flexShrink: 0, fontSize: 13, fontWeight: 700, padding: "8px 16px",
                  borderRadius: 8, border: "none", cursor: deleteInput === productionName ? "pointer" : "default",
                  background: deleteInput === productionName ? "#dc2626" : "#fca5a5",
                  color: "white", transition: "all .15s",
                }}
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export type SettingsPerms = {
  canRename: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canImportContacts: boolean;
  canImportScript: boolean;
  canImportScenes: boolean;
};

export default function AdminSettingsClient({
  productionId,
  productionName,
  isArchived,
  perms,
}: {
  productionId: string;
  productionName: string;
  isArchived: boolean;
  perms: SettingsPerms;
}) {
  return (
    <div style={{ overflowY: "auto", background: "var(--paper)", minHeight: "100%" }}>
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 48px", maxWidth: 720 }}>
        {/* Page header */}
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", marginBottom: 4 }}>
          Admin · Settings
        </p>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", marginBottom: 24 }}>
          项目管理
          {isArchived && (
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: "#f97316", background: "#ffedd5", borderRadius: 6, padding: "2px 8px", verticalAlign: "middle" }}>
              已归档
            </span>
          )}
        </h1>

        <RenameSection
          productionId={productionId}
          initialName={productionName}
          canRename={perms.canRename}
        />

        <ImportContactsSection
          productionId={productionId}
          canImport={perms.canImportContacts}
        />

        <ImportDataSection
          productionId={productionId}
          canScript={perms.canImportScript}
          canScenes={perms.canImportScenes}
        />

        <DangerSection
          productionId={productionId}
          productionName={productionName}
          isArchived={isArchived}
          canArchive={perms.canArchive}
          canDelete={perms.canDelete}
        />
      </div>
    </div>
  );
}
