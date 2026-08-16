"use client";

import PageHeader from "@/components/PageHeader";

import { useState, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";

type Milestone = {
  id: string;
  name: string;
  endDate: string;
  sortOrder: number;
};

type Props = {
  productionName: string;
  productionId: string;
  initialMilestones: Milestone[];
  canCreate: boolean;
  canManage: boolean;
  canDelete: boolean;
};

function isCurrentMilestone(endDate: string, today: string): boolean {
  return endDate >= today;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${y} 年 ${m} 月 ${d} 日`;
}

function daysDiff(endDate: string, today: string): number {
  const end = new Date(endDate);
  const now = new Date(today);
  return Math.ceil((end.getTime() - now.getTime()) / 86400000);
}

export default function AdminMilestonesClient({ productionId, productionName, initialMilestones, canCreate, canManage, canDelete }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [milestones, setMilestones] = useState<Milestone[]>(initialMilestones);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDate, setEditDate] = useState("");
  const [saving, setSaving] = useState(false);

  // New milestone form
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const startEdit = (m: Milestone) => {
    setEditingId(m.id);
    setEditName(m.name);
    setEditDate(m.endDate);
  };

  const cancelEdit = () => { setEditingId(null); setEditName(""); setEditDate(""); };

  const saveEdit = useCallback(async () => {
    if (!editingId || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/milestones/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim(), endDate: editDate }),
      });
      if (res.ok) {
        setMilestones(ms => ms.map(m => m.id === editingId ? { ...m, name: editName.trim(), endDate: editDate } : m));
        cancelEdit();
      }
    } finally { setSaving(false); }
  }, [editingId, editName, editDate, productionId, saving]);

  const deleteMilestone = useCallback(async (id: string, name: string) => {
    if (!confirm(`删除里程碑「${name}」？`)) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/milestones/${id}`, { method: "DELETE" });
    if (res.ok) setMilestones(ms => ms.filter(m => m.id !== id));
  }, [productionId]);

  const addMilestone = useCallback(async () => {
    if (!newName.trim() || !newDate || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), endDate: newDate }),
      });
      const data = await res.json() as { milestone?: Milestone; error?: string };
      if (res.ok && data.milestone) {
        setMilestones(ms => [...ms, data.milestone!].sort((a, b) => a.endDate.localeCompare(b.endDate)));
        setNewName("");
        setNewDate("");
      } else {
        setAddError(data.error ?? "添加失败");
      }
    } finally { setAdding(false); }
  }, [newName, newDate, productionId, adding]);

  // Current = first upcoming, Past = already passed
  const upcoming = milestones.filter(m => m.endDate >= today);
  const past = milestones.filter(m => m.endDate < today);
  const currentId = upcoming[0]?.id;

  const renderRow = (m: Milestone, isPast: boolean) => {
    const isCurrent = m.id === currentId;
    const diff = daysDiff(m.endDate, today);
    const isEditing = editingId === m.id;

    return (
      <div
        key={m.id}
        style={{
          display: "flex", flexDirection: "column", gap: 0,
          padding: "14px 16px",
          borderRadius: 10,
          border: isCurrent
            ? "1.5px solid var(--ink)"
            : isPast ? "1px solid var(--line)" : "1px solid var(--line)",
          background: isCurrent ? "var(--ink)" : "var(--surface)",
          opacity: isPast ? 0.65 : 1,
          transition: "box-shadow .15s",
        }}
      >
        {isEditing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
              style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--ink)", borderRadius: 6, padding: "6px 10px", outline: "none" }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="date"
                value={editDate}
                onChange={e => setEditDate(e.target.value)}
                style={{ fontSize: 13, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 6, padding: "5px 10px", outline: "none" }}
              />
              <div style={{ flex: 1 }} />
              <button onClick={cancelEdit} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "4px 8px" }}>取消</button>
              <button
                onClick={saveEdit}
                disabled={!editName.trim() || !editDate || saving}
                style={{ fontSize: 12, fontWeight: 600, color: "white", background: "var(--ink)", border: "none", borderRadius: 6, cursor: "pointer", padding: "5px 12px" }}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                {isCurrent && (
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", color: "rgba(255,255,255,.7)", textTransform: "uppercase" }}>
                    当前
                  </span>
                )}
                <span style={{ fontSize: 14, fontWeight: 600, color: isCurrent ? "white" : "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.name}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: isCurrent ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
                  {formatDate(m.endDate)}
                </span>
                {!isPast && (
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    color: isCurrent
                      ? (diff <= 7 ? "#fbbf24" : "rgba(255,255,255,.55)")
                      : (diff <= 7 ? "var(--danger)" : "var(--muted)"),
                  }}>
                    {diff === 0 ? "今天截止" : diff < 0 ? `已过期 ${-diff} 天` : `${diff} 天后`}
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {canManage && (
                <button
                  onClick={() => startEdit(m)}
                  style={{ fontSize: 12, color: isCurrent ? "rgba(255,255,255,.7)" : "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "4px 8px", borderRadius: 5 }}
                  title="编辑"
                >
                  编辑
                </button>
              )}
              {canDelete && (
                <button
                  onClick={() => deleteMilestone(m.id, m.name)}
                  style={{ fontSize: 12, color: isCurrent ? "rgba(255,255,255,.5)" : "var(--danger)40", background: "none", border: "none", cursor: "pointer", padding: "4px 8px", borderRadius: 5 }}
                  title="删除"
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--danger)")}
                  onMouseLeave={e => (e.currentTarget.style.color = isCurrent ? "rgba(255,255,255,.5)" : "var(--danger)40")}
                >
                  删除
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ overflowY: "auto", background: "var(--paper)", minHeight: "100%" }}>
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px" }}>
        <PageHeader eyebrow={productionName} title="里程碑" side="stage" />

        {/* Add form */}
        {canCreate && (
          <div style={{ background: "var(--surface)", borderRadius: 13, border: "1px solid var(--line)", padding: 22, marginBottom: 18 }}>
            <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>New Milestone</p>
            <h2 style={{ margin: "0 0 14px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>新增里程碑</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={newName}
                onChange={e => { setNewName(e.target.value); setAddError(null); }}
                onKeyDown={e => { if (e.key === "Enter") addMilestone(); }}
                placeholder="里程碑名称，例如「首演」「联排开始」"
                style={{ flex: 1, minWidth: 160, fontSize: 13, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", outline: "none" }}
                onFocus={e => { e.currentTarget.style.borderColor = "var(--ink)"; }}
                onBlur={e => { e.currentTarget.style.borderColor = "var(--line)"; }}
              />
              <input
                type="date"
                value={newDate}
                onChange={e => { setNewDate(e.target.value); setAddError(null); }}
                style={{ fontSize: 13, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", outline: "none" }}
                onFocus={e => { e.currentTarget.style.borderColor = "var(--ink)"; }}
                onBlur={e => { e.currentTarget.style.borderColor = "var(--line)"; }}
              />
              <button
                onClick={addMilestone}
                disabled={!newName.trim() || !newDate || adding}
                style={{
                  flexShrink: 0, fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 8, border: "none",
                  background: newName.trim() && newDate ? "var(--ink)" : "var(--line)",
                  color: newName.trim() && newDate ? "white" : "var(--muted)",
                  cursor: newName.trim() && newDate ? "pointer" : "default", transition: "all .15s",
                }}
              >
                {adding ? "添加中…" : "添加"}
              </button>
            </div>
            {addError && <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{addError}</p>}
          </div>
        )}

        {/* Upcoming */}
        {upcoming.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10 }}>即将到来</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {upcoming.map(m => renderRow(m, false))}
            </div>
          </div>
        )}

        {/* Past */}
        {past.length > 0 && (
          <div>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10 }}>已完成</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...past].reverse().map(m => renderRow(m, true))}
            </div>
          </div>
        )}

        {milestones.length === 0 && !canCreate && (
          <div style={{ padding: "48px 0", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            暂无里程碑
          </div>
        )}
      </div>
    </div>
  );
}
