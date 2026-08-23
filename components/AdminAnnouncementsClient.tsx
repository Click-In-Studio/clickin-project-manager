"use client";

import PageHeader, { PRIMARY_BTN } from "@/components/PageHeader";

import { useState, useCallback, useEffect } from "react";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import SmartTextarea from "@/components/SmartTextarea";
import { BASE_PATH } from "@/lib/base-path";

type Announcement = {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
};

type ReadMember = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  readAt: string | null;
};

type ReadStatus = {
  read: ReadMember[];
  unread: ReadMember[];
  total: number;
};

type Props = {
  productionId: string;
  productionName: string;
  recent30Count: number;
  initialAnnouncements: Announcement[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

type Mode = { kind: "view"; id: string } | { kind: "edit"; id: string } | { kind: "new" };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}

// ── 成员名片 ──────────────────────────────────────────────────────────────────

function MemberChip({ member }: { member: ReadMember }) {
  const initial = member.name.charAt(0).toUpperCase();
  return (
    <div
      title={member.readAt ? `已读于 ${new Date(member.readAt).toLocaleString("zh-CN")}` : member.name}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 10px 3px 4px", borderRadius: 999,
        background: "var(--surface-2)", fontSize: 12, color: "var(--ink)",
        whiteSpace: "nowrap",
      }}
    >
      <div style={{
        width: 20, height: 20, borderRadius: "50%",
        background: "var(--line)", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, fontWeight: 700, color: "var(--ink)",
        overflow: "hidden",
      }}>
        {member.avatarUrl
          ? <img src={member.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : initial}
      </div>
      {member.name}
    </div>
  );
}

// ── 编辑/新建表单 ─────────────────────────────────────────────────────────────

function AnnouncementForm({
  productionId,
  initial,
  isNew,
  onSave,
  onCancel,
}: {
  productionId: string;
  initial: { title: string; content: string; isPinned: boolean };
  isNew: boolean;
  onSave: (updated: { title: string; content: string; isPinned: boolean }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [isPinned, setIsPinned] = useState(initial.isPinned);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = title.trim() !== initial.title || content !== initial.content || isPinned !== initial.isPinned;

  const handleSave = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      onSave({ title: title.trim(), content, isPinned });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Title */}
      <div>
        <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 6 }}>
          标题
        </label>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="公告标题…"
          autoFocus
          style={{
            width: "100%", boxSizing: "border-box", fontSize: 15, fontWeight: 600,
            color: "var(--ink)", background: "var(--paper)",
            border: "1px solid var(--line)", borderRadius: 8,
            padding: "9px 12px", outline: "none",
          }}
          onFocus={e => { e.currentTarget.style.borderColor = "var(--ink)"; }}
          onBlur={e => { e.currentTarget.style.borderColor = "var(--line)"; }}
        />
      </div>

      {/* Content */}
      <div>
        <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", display: "block", marginBottom: 6 }}>
          内容
        </label>
        <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", background: "var(--paper)" }}>
          <SmartTextarea
            value={content}
            onChange={setContent}
            markdown
            placeholder="公告正文，支持 Markdown 格式…"
            minHeight={180}
          />
        </div>
      </div>

      {/* Pin toggle */}
      <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}>
        <div
          onClick={() => setIsPinned(p => !p)}
          style={{
            width: 36, height: 20, borderRadius: 999,
            background: isPinned ? "var(--ink)" : "var(--line)",
            position: "relative", transition: "background .15s", flexShrink: 0,
          }}
        >
          <div style={{
            position: "absolute", top: 2, left: isPinned ? 18 : 2,
            width: 16, height: 16, borderRadius: "50%", background: "white",
            transition: "left .15s",
          }} />
        </div>
        <span style={{ fontSize: 13, color: "var(--ink)" }}>
          置顶此公告
          <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6 }}>（每个项目只能有一条置顶）</span>
        </span>
      </label>

      {error && <p style={{ fontSize: 12, color: "#dc2626" }}>{error}</p>}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <button
          onClick={onCancel}
          style={{ fontSize: 13, color: "var(--muted)", background: "none", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 16px", cursor: "pointer" }}
        >
          取消
        </button>
        <button
          onClick={handleSave}
          disabled={!title.trim() || saving || (!isNew && !dirty)}
          style={{
            fontSize: 13, fontWeight: 600, padding: "8px 20px", borderRadius: 8, border: "none",
            background: title.trim() && (isNew || dirty) ? "var(--ink)" : "var(--line)",
            color: title.trim() && (isNew || dirty) ? "white" : "var(--muted)",
            cursor: title.trim() && (isNew || dirty) ? "pointer" : "default", transition: "all .15s",
          }}
        >
          {saving ? "保存中…" : isNew ? "发布" : "保存修改"}
        </button>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function AdminAnnouncementsClient({ productionId, productionName, recent30Count, initialAnnouncements, canCreate, canEdit, canDelete }: Props) {
  const [announcements, setAnnouncements] = useState<Announcement[]>(initialAnnouncements);
  const [mode, setMode] = useState<Mode | null>(null);
  const [saving, setSaving] = useState(false);
  const [readStatus, setReadStatus] = useState<ReadStatus | null>(null);
  const [readStatusLoading, setReadStatusLoading] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [remindResult, setRemindResult] = useState<string | null>(null);

  const selected = mode?.kind !== "new" && mode ? announcements.find(a => a.id === mode.id) ?? null : null;

  // 切换到 view 时加载已读状态
  useEffect(() => {
    if (mode?.kind !== "view" || !mode.id) { setReadStatus(null); return; }
    const id = mode.id;
    setReadStatus(null);
    setReadStatusLoading(true);
    setRemindResult(null);
    fetch(`${BASE_PATH}/api/production/${productionId}/announcements/${id}/read-status`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setReadStatus(data as ReadStatus); })
      .finally(() => setReadStatusLoading(false));
  }, [mode?.kind === "view" ? mode.id : null, productionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNew = () => setMode({ kind: "new" });
  const handleSelect = (id: string) => setMode({ kind: "view", id });
  const handleEdit = (id: string) => setMode({ kind: "edit", id });
  const handleCancel = () => setMode(mode?.kind === "edit" && mode.id ? { kind: "view", id: mode.id } : null);

  const handleCreate = useCallback(async (fields: { title: string; content: string; isPinned: boolean }) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/announcements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = await res.json() as { announcement?: Announcement; error?: string };
      if (res.ok && data.announcement) {
        const newItem = data.announcement;
        setAnnouncements(prev => {
          const list = fields.isPinned ? prev.map(a => ({ ...a, isPinned: false })) : prev;
          return [newItem, ...list];
        });
        setMode({ kind: "view", id: newItem.id });
      }
    } finally { setSaving(false); }
  }, [productionId]);

  const handleUpdate = useCallback(async (id: string, fields: { title: string; content: string; isPinned: boolean }) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/announcements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (res.ok) {
        setAnnouncements(prev => {
          const list = fields.isPinned ? prev.map(a => ({ ...a, isPinned: a.id === id ? true : false })) : prev;
          return list.map(a => a.id === id ? { ...a, ...fields, updatedAt: new Date().toISOString() } : a);
        });
        setMode({ kind: "view", id });
      }
    } finally { setSaving(false); }
  }, [productionId]);

  const handleDelete = useCallback(async (id: string, title: string) => {
    if (!confirm(`删除公告「${title}」？`)) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/announcements/${id}`, { method: "DELETE" });
    if (res.ok) {
      setAnnouncements(prev => prev.filter(a => a.id !== id));
      if (mode?.kind !== "new" && mode?.id === id) setMode(null);
    }
  }, [productionId, mode]);

  const handlePin = useCallback(async (id: string, currentlyPinned: boolean) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/announcements/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPinned: !currentlyPinned }),
    });
    if (res.ok) {
      setAnnouncements(prev =>
        prev.map(a => ({
          ...a,
          isPinned: a.id === id ? !currentlyPinned : (currentlyPinned ? a.isPinned : false),
        }))
      );
    }
  }, [productionId]);

  const handleRemind = useCallback(async (id: string) => {
    setReminding(true);
    setRemindResult(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/announcements/${id}/remind`, { method: "POST" });
      const data = await res.json() as { ok?: boolean; sent?: number; message?: string };
      if (res.ok && data.ok) {
        setRemindResult(data.message ?? `已发送催读通知给 ${data.sent} 位成员`);
      }
    } finally { setReminding(false); }
  }, [productionId]);

  // Pinned first, then by date desc
  const sorted = [...announcements].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader
        eyebrow={productionName}
        title="公告管理"
        side="stage"
        actions={canCreate ? (
          <button style={PRIMARY_BTN} onClick={handleNew}>＋ 新建公告</button>
        ) : undefined}
      />

      {/* ── 摘要 ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(announcements.length), "全部公告", "本项目累计"],
          [String(announcements.filter(a => a.isPinned).length), "置顶", "重点公告"],
          [String(recent30Count), "近 30 天", "最近发布"],
        ].map(([num, label, hint]) => (
          <div key={label} style={{ minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13, background: "var(--surface)" }}>
            <span style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28, color: "var(--ink)" }}>{num}</span>
            <p style={{ margin: 0, display: "flex", flexDirection: "column" }}>
              <b style={{ fontSize: 11, color: "var(--ink)" }}>{label}</b>
              <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 9 }}>{hint}</small>
            </p>
          </div>
        ))}
      </div>

      {/* ── Panel（定高分栏）── */}
      <section style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22,
        height: "calc(100vh - 320px)", minHeight: 460, display: "flex", minWidth: 0,
      }}>

      {/* ── 左侧列表 ── */}
      <div style={{
        width: 280, flexShrink: 0,
        borderRight: "1px solid var(--line)",
        display: "flex", flexDirection: "column",
        overflowY: "auto",
      }}>
        {/* List */}
        <div style={{ flex: 1, paddingRight: 12 }}>
          {sorted.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--muted)", padding: "24px 8px", textAlign: "center" }}>暂无公告</p>
          )}
          {sorted.map(a => {
            const isActive = mode?.kind !== "new" && mode?.id === a.id;
            return (
              <button
                key={a.id}
                onClick={() => handleSelect(a.id)}
                style={{
                  width: "100%", textAlign: "left", padding: "11px 12px", borderRadius: 8,
                  border: `1px solid ${isActive ? "var(--ink)" : "transparent"}`,
                  background: isActive ? "var(--ink)" : "transparent",
                  cursor: "pointer", transition: "all .1s", marginBottom: 2,
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "var(--surface-2)"; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  {a.isPinned && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 999,
                      background: isActive ? "rgba(255,255,255,.2)" : "var(--surface-2)",
                      color: isActive ? "white" : "var(--ink)",
                    }}>
                      置顶
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: isActive ? "rgba(255,255,255,.5)" : "var(--muted)", marginLeft: "auto" }}>
                    {formatDate(a.createdAt)}
                  </span>
                </div>
                <p style={{
                  fontSize: 13, fontWeight: 600, color: isActive ? "white" : "var(--ink)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: 0,
                }}>
                  {a.title}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 右侧内容区 ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 4px 4px 22px", minWidth: 0 }}>
        {/* Empty state */}
        {!mode && (
          <div style={{ paddingTop: 80, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            {canCreate ? (
              <div>
                <p style={{ marginBottom: 12 }}>选择左侧公告查看详情，或新建一条公告</p>
                <button onClick={handleNew} style={{ fontSize: 13, fontWeight: 600, padding: "8px 20px", borderRadius: 8, border: "none", background: "var(--ink)", color: "white", cursor: "pointer" }}>
                  + 新建公告
                </button>
              </div>
            ) : (
              <p>选择左侧公告查看详情</p>
            )}
          </div>
        )}

        {/* New */}
        {mode?.kind === "new" && (
          <div style={{ maxWidth: 680 }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: "var(--stage)", letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 16 }}>新建公告</p>
            <AnnouncementForm
              productionId={productionId}
              initial={{ title: "", content: "", isPinned: false }}
              isNew
              onSave={handleCreate}
              onCancel={() => setMode(null)}
            />
          </div>
        )}

        {/* Edit */}
        {mode?.kind === "edit" && selected && (
          <div style={{ maxWidth: 680 }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: "var(--stage)", letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 16 }}>编辑公告</p>
            <AnnouncementForm
              productionId={productionId}
              initial={{ title: selected.title, content: selected.content, isPinned: selected.isPinned }}
              isNew={false}
              onSave={fields => handleUpdate(selected.id, fields)}
              onCancel={handleCancel}
            />
          </div>
        )}

        {/* View */}
        {mode?.kind === "view" && selected && (
          <div style={{ maxWidth: 680 }}>
            {/* Meta bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
              {selected.isPinned && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: "var(--ink)", color: "white" }}>
                  置顶
                </span>
              )}
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                发布于 {formatDate(selected.createdAt)}
                {selected.updatedAt !== selected.createdAt && ` · 更新于 ${formatDate(selected.updatedAt)}`}
              </span>

              {/* Actions */}
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                {canEdit && (
                  <>
                    <button
                      onClick={() => handlePin(selected.id, selected.isPinned)}
                      style={{ fontSize: 12, color: "var(--muted)", background: "var(--surface-2)", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer" }}
                      title={selected.isPinned ? "取消置顶" : "设为置顶"}
                    >
                      {selected.isPinned ? "取消置顶" : "置顶"}
                    </button>
                    <button
                      onClick={() => handleEdit(selected.id)}
                      style={{ fontSize: 12, color: "var(--ink)", background: "var(--surface-2)", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer" }}
                    >
                      编辑
                    </button>
                  </>
                )}
                {canDelete && (
                  <button
                    onClick={() => handleDelete(selected.id, selected.title)}
                    style={{ fontSize: 12, color: "#dc2626", background: "#fef2f2", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer" }}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>

            {/* Title */}
            <h2 style={{
              fontFamily: 'Georgia, "Noto Serif SC", serif',
              fontSize: "clamp(20px, 2vw, 26px)", fontWeight: 500,
              color: "var(--ink)", lineHeight: 1.3, marginBottom: 20,
            }}>
              {selected.title}
            </h2>

            {/* Divider */}
            <div style={{ height: 1, background: "var(--line)", marginBottom: 22 }} />

            {/* Content */}
            {selected.content ? (
              <WikiMarkdown
                content={selected.content}
                productionId={productionId}
              />
            ) : (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>（无内容）</p>
            )}

            {/* Read status panel */}
            <div style={{ marginTop: 32, borderTop: "1px solid var(--line)", paddingTop: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", margin: 0 }}>
                  阅读状态
                </p>
                {readStatusLoading && (
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>加载中…</span>
                )}
                {readStatus && !readStatusLoading && (
                  <>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      <span style={{ color: "#16a34a", fontWeight: 600 }}>{readStatus.read.length}</span> 已读 ·{" "}
                      <span style={{ color: readStatus.unread.length > 0 ? "#dc2626" : "var(--muted)", fontWeight: 600 }}>{readStatus.unread.length}</span> 未读 / 共 {readStatus.total} 人
                    </span>
                    {canEdit && readStatus.unread.length > 0 && (
                      <button
                        onClick={() => handleRemind(selected.id)}
                        disabled={reminding}
                        style={{
                          marginLeft: "auto", fontSize: 12, fontWeight: 600,
                          padding: "5px 14px", borderRadius: 7, border: "none",
                          background: reminding ? "var(--line)" : "var(--ink)",
                          color: reminding ? "var(--muted)" : "white",
                          cursor: reminding ? "default" : "pointer", transition: "all .15s",
                        }}
                      >
                        {reminding ? "发送中…" : `催读（${readStatus.unread.length} 人）`}
                      </button>
                    )}
                  </>
                )}
              </div>
              {remindResult && (
                <p style={{ fontSize: 12, color: "#16a34a", marginBottom: 12 }}>{remindResult}</p>
              )}
              {readStatus && (
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  {/* 未读列表 */}
                  {readStatus.unread.length > 0 && (
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".04em" }}>
                        未读 ({readStatus.unread.length})
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {readStatus.unread.map(m => (
                          <MemberChip key={m.userId} member={m} />
                        ))}
                      </div>
                    </div>
                  )}
                  {/* 已读列表 */}
                  {readStatus.read.length > 0 && (
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: "#16a34a", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".04em" }}>
                        已读 ({readStatus.read.length})
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {readStatus.read.map(m => (
                          <MemberChip key={m.userId} member={m} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      </section>
    </div>
  );
}
