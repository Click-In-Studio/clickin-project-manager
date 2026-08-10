"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";

// ── Primitives ────────────────────────────────────────────────────────────────

const LABEL_COL = 220;

const INPUT: React.CSSProperties = {
  fontSize: 13, color: "var(--ink)",
  background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8,
  padding: "7px 11px", outline: "none", boxSizing: "border-box",
};

const BTN = (active: boolean): React.CSSProperties => ({
  flexShrink: 0, fontSize: 12, fontWeight: 600,
  padding: "7px 14px", borderRadius: 7, border: "none",
  background: active ? "var(--ink)" : "var(--line)",
  color: active ? "white" : "var(--muted)",
  cursor: active ? "pointer" : "default", transition: "background .15s, color .15s",
  whiteSpace: "nowrap",
});

function LockedNotice({ reason }: { reason: string }) {
  return (
    <p style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>🔒 {reason}</p>
  );
}

// ── Setting row: label left, control right ────────────────────────────────────

function Row({ title, hint, last, children }: {
  title: string; hint?: string; last?: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `${LABEL_COL}px 1fr`,
      gap: 24,
      padding: "18px 24px",
      borderBottom: last ? "none" : "1px solid var(--line)",
      alignItems: "start",
    }}>
      <div style={{ paddingTop: 1 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{title}</p>
        {hint && <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 3, lineHeight: 1.5 }}>{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Card({ title, children, danger }: {
  title?: string; children: React.ReactNode; danger?: boolean;
}) {
  return (
    <div style={{
      background: "white", borderRadius: 12, overflow: "hidden",
      border: danger ? "1px solid #fca5a5" : "1px solid var(--line)",
      marginBottom: 20,
    }}>
      {title && (
        <div style={{
          padding: "14px 24px",
          borderBottom: "1px solid var(--line)",
          background: danger ? "#fff5f5" : "var(--surface)",
        }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: danger ? "#dc2626" : "var(--muted)", letterSpacing: ".07em", textTransform: "uppercase" }}>
            {title}
          </p>
        </div>
      )}
      {children}
    </div>
  );
}

// ── Save button with feedback ─────────────────────────────────────────────────

function SaveBtn({ dirty, saving, saved, onClick }: {
  dirty: boolean; saving: boolean; saved: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} disabled={!dirty || saving} style={BTN(dirty)}>
      {saved ? "已保存 ✓" : saving ? "保存中…" : "保存"}
    </button>
  );
}

function useSave(productionId: string) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (field: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(field),
      });
      if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); }
    } finally { setSaving(false); }
  };

  return { save, saving, saved, clearSaved: () => setSaved(false) };
}

// ── Project type list ─────────────────────────────────────────────────────────

const PRODUCTION_TYPES = [
  { value: "stage_play", label: "话剧" },
  { value: "theatre", label: "舞台剧" },
  { value: "musical", label: "音乐剧" },
  { value: "gala", label: "综合晚会" },
  { value: "music_festival", label: "音乐节" },
  { value: "concert", label: "音乐会" },
  { value: "short_film", label: "短片" },
  { value: "film", label: "电影" },
  { value: "tv_drama", label: "电视剧" },
  { value: "radio_drama", label: "广播剧" },
  { value: "album", label: "专辑" },
  { value: "other", label: "其他" },
] as const;

const SELECT_STYLE: React.CSSProperties = {
  ...INPUT,
  appearance: "none",
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center",
  paddingRight: 28,
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export type SettingsPerms = {
  canRename: boolean;
  canChangeAvatar: boolean;
  canEditDescription: boolean;
  canChangeType: boolean;
  canChangeLanguage: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canImportContacts: boolean;
  canImportScript: boolean;
  canImportScenes: boolean;
  canManageTags: boolean;
};

export type InitialMeta = {
  name: string;
  description: string;
  avatarUrl: string | null;
  type: string | null;
  typeLabel: string | null;
  language: string | null;
};

export default function AdminSettingsClient({
  productionId,
  initialMeta,
  isArchived,
  perms,
}: {
  productionId: string;
  initialMeta: InitialMeta;
  isArchived: boolean;
  perms: SettingsPerms;
}) {
  return (
    <div style={{ overflowY: "auto", background: "var(--paper)", minHeight: "100%" }}>
      <div style={{ padding: "24px clamp(20px, 3vw, 48px) 56px" }}>

        {/* Page header */}
        <div style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", marginBottom: 4 }}>
            Admin · Settings
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em" }}>
              项目管理
            </h1>
            {isArchived && (
              <span style={{ fontSize: 11, fontWeight: 600, color: "#f97316", background: "#ffedd5", borderRadius: 6, padding: "2px 8px" }}>
                已归档
              </span>
            )}
          </div>
        </div>

        {/* ── 基本信息 ── */}
        <BasicInfoCard productionId={productionId} initialMeta={initialMeta} perms={perms} />

        {/* ── 成员标签 ── */}
        <MemberTagsCard productionId={productionId} perms={perms} />

        {/* ── 数据 ── */}
        <DataCard productionId={productionId} perms={perms} />

        {/* ── 危险区域 ── */}
        <DangerCard productionId={productionId} productionName={initialMeta.name} isArchived={isArchived} perms={perms} />

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 基本信息 card
// ─────────────────────────────────────────────────────────────────────────────

function BasicInfoCard({ productionId, initialMeta, perms }: {
  productionId: string;
  initialMeta: InitialMeta;
  perms: SettingsPerms;
}) {
  const [name, setName] = useState(initialMeta.name);
  const [description, setDescription] = useState(initialMeta.description);
  const [type, setType] = useState(initialMeta.type ?? "");
  const [typeLabel, setTypeLabel] = useState(initialMeta.typeLabel ?? "");
  const [language, setLanguage] = useState(initialMeta.language ?? "");

  // Avatar upload state
  const [hasAvatar, setHasAvatar] = useState(initialMeta.avatarUrl !== null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [avatarCacheBust, setAvatarCacheBust] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const nameSave = useSave(productionId);
  const descSave = useSave(productionId);
  const typeSave = useSave(productionId);
  const langSave = useSave(productionId);

  const nameDirty = name.trim() !== initialMeta.name && name.trim().length > 0;
  const descDirty = description !== initialMeta.description;
  const typeDirty = type !== (initialMeta.type ?? "") || (type === "other" && typeLabel !== (initialMeta.typeLabel ?? ""));
  const langDirty = language.trim() !== (initialMeta.language ?? "");

  const inputFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = "var(--ink)";
  };
  const inputBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = "var(--line)";
  };

  const handleAvatarFile = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setAvatarMsg({ ok: false, text: "图片不能超过 5 MB" });
      return;
    }
    setAvatarUploading(true);
    setAvatarMsg(null);
    try {
      // 1. Presign
      const presignRes = await fetch(`${BASE_PATH}/api/production/${productionId}/avatar/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: file.type }),
      });
      if (!presignRes.ok) throw new Error("presign failed");
      const { uploadUrl, r2Key } = await presignRes.json() as { uploadUrl: string; r2Key: string };

      // 2. Upload to R2
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("upload failed");

      // 3. Save r2Key to production
      const patchRes = await fetch(`${BASE_PATH}/api/production/${productionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: r2Key }),
      });
      if (!patchRes.ok) throw new Error("patch failed");

      setHasAvatar(true);
      setAvatarCacheBust(v => v + 1);
      setAvatarMsg({ ok: true, text: "头像已更新" });
    } catch {
      setAvatarMsg({ ok: false, text: "上传失败，请重试" });
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const avatarSrc = hasAvatar
    ? `${BASE_PATH}/api/production/${productionId}/avatar?t=${avatarCacheBust}`
    : null;

  return (
    <Card title="基本信息">
      {/* 项目名称 */}
      <Row title="项目名称" hint="显示于项目列表、管理后台标题栏">
        {!perms.canRename ? <LockedNotice reason="需要 production:rename 权限" /> : (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={name}
              onChange={e => { setName(e.target.value); nameSave.clearSaved(); }}
              onKeyDown={e => { if (e.key === "Enter" && nameDirty) nameSave.save({ name: name.trim() }); }}
              placeholder="项目名称"
              style={{ ...INPUT, flex: 1, fontWeight: 500 }}
              onFocus={inputFocus} onBlur={inputBlur}
            />
            <SaveBtn dirty={nameDirty} saving={nameSave.saving} saved={nameSave.saved} onClick={() => nameSave.save({ name: name.trim() })} />
          </div>
        )}
      </Row>

      {/* 头像 */}
      <Row title="项目头像" hint="展示于项目列表和顶栏，JPG / PNG / WebP，最大 5 MB">
        {!perms.canChangeAvatar ? <LockedNotice reason="需要 production:change_avatar 权限" /> : (
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* Preview */}
            <div style={{
              width: 56, height: 56, borderRadius: 10, flexShrink: 0, overflow: "hidden",
              border: "1px solid var(--line)", background: "var(--surface)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {avatarSrc ? (
                <img
                  key={avatarCacheBust}
                  src={avatarSrc}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  onError={() => setHasAvatar(false)}
                />
              ) : (
                <span style={{ fontSize: 22, opacity: 0.25 }}>🎭</span>
              )}
            </div>

            {/* Controls */}
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                style={{ display: "none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleAvatarFile(f); }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarUploading}
                style={{ fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 7, border: "1px solid var(--line)", background: "white", color: "var(--ink)", cursor: avatarUploading ? "default" : "pointer", transition: "all .15s" }}
                onMouseEnter={e => { if (!avatarUploading) { e.currentTarget.style.background = "var(--ink)"; e.currentTarget.style.color = "white"; e.currentTarget.style.borderColor = "var(--ink)"; } }}
                onMouseLeave={e => { e.currentTarget.style.background = "white"; e.currentTarget.style.color = "var(--ink)"; e.currentTarget.style.borderColor = "var(--line)"; }}
              >
                {avatarUploading ? "上传中…" : hasAvatar ? "更换头像" : "上传头像"}
              </button>
              {avatarMsg && (
                <p style={{ fontSize: 11, color: avatarMsg.ok ? "#16a34a" : "#dc2626", margin: 0 }}>
                  {avatarMsg.ok ? "✓ " : ""}{avatarMsg.text}
                </p>
              )}
            </div>
          </div>
        )}
      </Row>

      {/* 简介 */}
      <Row title="项目简介" hint="在项目首页展示，简短介绍背景或特色">
        {!perms.canEditDescription ? <LockedNotice reason="需要 production:edit_description 权限" /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              value={description}
              onChange={e => { setDescription(e.target.value); descSave.clearSaved(); }}
              rows={3}
              placeholder="一两句话介绍这个项目…"
              style={{ ...INPUT, width: "100%", resize: "vertical", lineHeight: 1.6, fontFamily: "inherit" }}
              onFocus={inputFocus} onBlur={inputBlur}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <SaveBtn dirty={descDirty} saving={descSave.saving} saved={descSave.saved} onClick={() => descSave.save({ description })} />
            </div>
          </div>
        )}
      </Row>

      {/* 类型 */}
      <Row title="项目类型" hint="未来将绑定模版与导航别称">
        {!perms.canChangeType ? <LockedNotice reason="需要 production:change_type 权限" /> : (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={type}
              onChange={e => { setType(e.target.value); typeSave.clearSaved(); if (e.target.value !== "other") setTypeLabel(""); }}
              style={{ ...SELECT_STYLE, minWidth: 130, flex: "none" }}
              onFocus={inputFocus} onBlur={inputBlur}
            >
              <option value="">— 未设置 —</option>
              {PRODUCTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {type === "other" && (
              <input
                value={typeLabel}
                onChange={e => { setTypeLabel(e.target.value); typeSave.clearSaved(); }}
                placeholder="自定义类型名称"
                style={{ ...INPUT, flex: 1, minWidth: 100 }}
                onFocus={inputFocus} onBlur={inputBlur}
              />
            )}
            <SaveBtn dirty={typeDirty} saving={typeSave.saving} saved={typeSave.saved} onClick={() => typeSave.save({ type: type || null, typeLabel: type === "other" ? (typeLabel || null) : null })} />
          </div>
        )}
      </Row>

      {/* 语言 */}
      <Row title="语言" hint="项目主要语言，展示属性" last>
        {!perms.canChangeLanguage ? <LockedNotice reason="需要 production:change_language 权限" /> : (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={language}
              onChange={e => { setLanguage(e.target.value); langSave.clearSaved(); }}
              onKeyDown={e => { if (e.key === "Enter" && langDirty) langSave.save({ language: language.trim() || null }); }}
              placeholder="普通话 / 英语"
              style={{ ...INPUT, flex: 1 }}
              onFocus={inputFocus} onBlur={inputBlur}
            />
            <SaveBtn dirty={langDirty} saving={langSave.saving} saved={langSave.saved} onClick={() => langSave.save({ language: language.trim() || null })} />
          </div>
        )}
      </Row>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 成员标签 card
// ─────────────────────────────────────────────────────────────────────────────

type MemberTag = { id: string; name: string; isSystem: boolean };

function MemberTagsCard({ productionId, perms }: { productionId: string; perms: SettingsPerms }) {
  const [tags, setTags] = useState<MemberTag[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/member-tags`)
      .then((r) => r.json())
      .then((data: { tags?: MemberTag[] }) => setTags(data.tags ?? []))
      .catch(() => {});
  }, [productionId]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/member-tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json() as { tag?: MemberTag; error?: string };
      if (res.ok && data.tag) {
        setTags((prev) => [...prev, data.tag!]);
        setNewName("");
      } else {
        setError(data.error ?? "创建失败");
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (tag: MemberTag) => {
    if (!confirm(`确定删除标签「${tag.name}」？已分配该标签的成员将自动移除。`)) return;
    setDeletingIds((s) => new Set(s).add(tag.id));
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/member-tags/${tag.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setTags((prev) => prev.filter((t) => t.id !== tag.id));
      } else {
        const data = await res.json() as { error?: string };
        setError(data.error ?? "删除失败");
      }
    } finally {
      setDeletingIds((s) => { const n = new Set(s); n.delete(tag.id); return n; });
    }
  };

  const inputFocus = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = "var(--ink)"; };
  const inputBlur = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = "var(--line)"; };

  const systemTags = tags.filter((t) => t.isSystem);
  const customTags = tags.filter((t) => !t.isSystem);

  return (
    <Card title="成员标签">
      <Row title="系统标签" hint="内置标签，不可删除">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {systemTags.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>—</p>
          ) : systemTags.map((t) => (
            <span key={t.id} style={{ fontSize: 12, padding: "3px 10px", borderRadius: 20, background: "#eff6ff", color: "#3b82f6", border: "1px solid #bfdbfe" }}>
              {t.name}
            </span>
          ))}
        </div>
      </Row>

      <Row title="自定义标签" hint="演出专属标签，可创建或删除" last>
        {!perms.canManageTags ? <LockedNotice reason="需要 members:change_role 权限" /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Existing custom tags */}
            {customTags.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {customTags.map((t) => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, padding: "3px 6px 3px 10px", borderRadius: 20, background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0" }}>
                    {t.name}
                    <button
                      onClick={() => handleDelete(t)}
                      disabled={deletingIds.has(t.id)}
                      style={{ fontSize: 13, lineHeight: 1, color: "#86efac", cursor: "pointer", border: "none", background: "none", padding: "0 2px", opacity: deletingIds.has(t.id) ? 0.4 : 1 }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {customTags.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--muted)" }}>暂无自定义标签</p>
            )}
            {/* Create new */}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={newName}
                onChange={(e) => { setNewName(e.target.value); setError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
                placeholder="新标签名称…"
                style={{ ...INPUT, flex: 1 }}
                onFocus={inputFocus} onBlur={inputBlur}
              />
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                style={BTN(!!newName.trim())}
              >
                {creating ? "创建中…" : "创建"}
              </button>
            </div>
            {error && <p style={{ fontSize: 12, color: "#dc2626" }}>{error}</p>}
          </div>
        )}
      </Row>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 数据 card
// ─────────────────────────────────────────────────────────────────────────────

function DataCard({ productionId, perms }: { productionId: string; perms: SettingsPerms }) {
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
      const data = await res.json() as { ok?: boolean; stats?: { matched: number; created: number; notFound: string[] }; error?: string };
      if (res.ok && data.stats) {
        const { matched, created, notFound } = data.stats;
        const parts: string[] = [];
        if (matched) parts.push(`匹配 ${matched} 人`);
        if (created) parts.push(`新建 ${created} 人`);
        const notFoundMsg = notFound.length ? `；${notFound.length} 人未找到：${notFound.slice(0, 5).join("、")}${notFound.length > 5 ? "…" : ""}` : "";
        setResult({ ok: true, message: `导入完成：${parts.join("，") || "无变化"}${notFoundMsg}` });
        setUrl("");
      } else {
        setResult({ ok: false, message: (data as { error?: string }).error ?? "导入失败" });
      }
    } catch {
      setResult({ ok: false, message: "网络错误" });
    } finally { setLoading(false); }
  };

  const importLinks = [
    { label: "导入剧本", desc: "从飞书表格导入台词、角色、场景号", href: `/production/${productionId}/import-script`, can: perms.canImportScript, lock: "script:import" },
    { label: "导入构作", desc: "从飞书表格导入场次、梗概、时长", href: `/production/${productionId}/import-scenes`, can: perms.canImportScenes, lock: "dramaturgy:import" },
  ];

  const inputFocus = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = "var(--ink)"; };
  const inputBlur = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = "var(--line)"; };

  return (
    <Card title="数据">
      {/* 批量导入人员 */}
      <Row title="批量导入人员" hint="从飞书多维表格同步通讯录">
        {!perms.canImportContacts ? <LockedNotice reason="需要 contacts:import 权限" /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={url}
                onChange={e => { setUrl(e.target.value); setResult(null); }}
                onKeyDown={e => { if (e.key === "Enter") handleImport(); }}
                placeholder="粘贴飞书多维表格 Wiki 链接…"
                style={{ ...INPUT, flex: 1 }}
                onFocus={inputFocus} onBlur={inputBlur}
              />
              <button
                onClick={handleImport}
                disabled={!url.trim() || loading}
                style={{ ...BTN(!!url.trim()), background: url.trim() ? "var(--script)" : "var(--line)", color: url.trim() ? "white" : "var(--muted)" }}
              >
                {loading ? "导入中…" : "导入"}
              </button>
            </div>
            {result && (
              <p style={{ fontSize: 12, color: result.ok ? "#16a34a" : "#dc2626" }}>{result.message}</p>
            )}
          </div>
        )}
      </Row>

      {/* 导入剧本 / 构作 */}
      <Row title="导入数据" hint="跳转至专属导入页面" last>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {importLinks.map(item => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--paper)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{item.label}</p>
                <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{item.desc}</p>
              </div>
              {item.can ? (
                <Link
                  href={item.href}
                  style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, padding: "5px 13px", borderRadius: 7, border: "1px solid var(--ink)", color: "var(--ink)", background: "white", textDecoration: "none" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--ink)"; e.currentTarget.style.color = "white"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "white"; e.currentTarget.style.color = "var(--ink)"; }}
                >
                  前往 →
                </Link>
              ) : (
                <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>🔒 {item.lock}</span>
              )}
            </div>
          ))}
        </div>
      </Row>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 危险区域 card
// ─────────────────────────────────────────────────────────────────────────────

function DangerCard({ productionId, productionName, isArchived, perms }: {
  productionId: string;
  productionName: string;
  isArchived: boolean;
  perms: SettingsPerms;
}) {
  const router = useRouter();
  const [archiving, setArchiving] = useState(false);
  const [archiveMsg, setArchiveMsg] = useState<string | null>(null);
  const [currentArchived, setCurrentArchived] = useState(isArchived);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);

  const handleArchive = async () => {
    const action = currentArchived ? "取消归档" : "归档";
    if (!confirm(`确定${action}项目「${productionName}」？`)) return;
    setArchiving(true);
    setArchiveMsg(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/archive`, {
        method: currentArchived ? "DELETE" : "POST",
      });
      if (res.ok) { setCurrentArchived(!currentArchived); setArchiveMsg(currentArchived ? "已取消归档" : "已归档"); }
      else { const d = await res.json() as { error?: string }; setArchiveMsg(`失败：${d.error ?? "未知错误"}`); }
    } finally { setArchiving(false); }
  };

  const handleDelete = async () => {
    if (deleteInput !== productionName) return;
    if (!confirm(`⚠️ 最终确认：彻底删除项目「${productionName}」，所有数据将永久丢失，无法恢复。\n\n确认删除？`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}`, { method: "DELETE" });
      if (res.ok) { router.push("/"); }
      else { const d = await res.json() as { error?: string }; alert(`删除失败：${d.error ?? "未知错误"}`); setDeleting(false); }
    } catch { alert("网络错误，删除失败"); setDeleting(false); }
  };

  const inputFocus = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = "var(--ink)"; };
  const inputBlur = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = "var(--line)"; };

  return (
    <Card title="危险区域" danger>
      {/* Archive */}
      <Row title={currentArchived ? "取消归档" : "归档项目"} hint={currentArchived ? "恢复项目为活跃状态，成员可继续编辑" : "标记为归档，成员只读，不再出现于常用列表"}>
        {!perms.canArchive ? (
          <LockedNotice reason="需要 production:archive 权限" />
        ) : (
          <div>
            <button
              onClick={handleArchive}
              disabled={archiving}
              style={{ fontSize: 12, fontWeight: 600, padding: "7px 14px", borderRadius: 7, border: "1px solid", cursor: "pointer", background: "white", transition: "all .15s", borderColor: currentArchived ? "#16a34a" : "#f97316", color: currentArchived ? "#16a34a" : "#f97316" }}
            >
              {archiving ? "处理中…" : currentArchived ? "取消归档" : "归档"}
            </button>
            {archiveMsg && <p style={{ marginTop: 6, fontSize: 12, color: "#16a34a" }}>{archiveMsg}</p>}
          </div>
        )}
      </Row>

      {/* Delete */}
      <Row title="删除项目" hint="彻底删除项目及所有数据，不可撤销" last>
        {!perms.canDelete ? (
          <LockedNotice reason="仅项目所有者可删除（production:delete）" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>
              输入项目名称 <strong style={{ color: "var(--ink)" }}>「{productionName}」</strong> 以确认：
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={deleteInput}
                onChange={e => setDeleteInput(e.target.value)}
                placeholder={productionName}
                style={{ ...INPUT, flex: 1, borderColor: "#fca5a5" }}
                onFocus={inputFocus} onBlur={inputBlur}
              />
              <button
                onClick={handleDelete}
                disabled={deleteInput !== productionName || deleting}
                style={{ fontSize: 12, fontWeight: 700, padding: "7px 14px", borderRadius: 7, border: "none", cursor: deleteInput === productionName ? "pointer" : "default", background: deleteInput === productionName ? "#dc2626" : "#fca5a5", color: "white", transition: "all .15s", whiteSpace: "nowrap" }}
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        )}
      </Row>
    </Card>
  );
}
