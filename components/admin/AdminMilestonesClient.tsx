"use client";

import styles from "./admin-milestones.module.css";

import { useState, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";

type Milestone = {
  id: string;
  name: string;
  endDate: string;
  sortOrder: number;
};

type Props = {
  productionId: string;
  initialMilestones: Milestone[];
  canCreate: boolean;
  canManage: boolean;
  canDelete: boolean;
};

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${y} 年 ${m} 月 ${d} 日`;
}

function daysDiff(endDate: string, today: string): number {
  const end = new Date(endDate);
  const now = new Date(today);
  return Math.ceil((end.getTime() - now.getTime()) / 86400000);
}

export default function AdminMilestonesClient({ productionId, initialMilestones, canCreate, canManage, canDelete }: Props) {
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
        className={styles.milestoneRow}
        style={{
          border: isCurrent
            ? "1.5px solid var(--ink)"
            : isPast ? "1px solid var(--line)" : "1px solid var(--line)",
          background: isCurrent ? "var(--ink)" : "var(--surface)",
          opacity: isPast ? 0.65 : 1,
        }}
      >
        {isEditing ? (
          <div className={styles.editForm}>
            <input
              className={`${styles.input} ${styles.editNameInput}`}
              value={editName}
              onChange={e => setEditName(e.target.value)}
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
            />
            <div className={styles.editFooter}>
              <input
                className={`${styles.input} ${styles.editDateInput}`}
                type="date"
                value={editDate}
                onChange={e => setEditDate(e.target.value)}
              />
              <div className={styles.editSpacer} />
              <button className={styles.cancelButton} onClick={cancelEdit}>取消</button>
              <button
                className={styles.saveButton}
                onClick={saveEdit}
                disabled={!editName.trim() || !editDate || saving}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.displayRow}>
            <div className={styles.milestoneCopy}>
              <div className={styles.titleLine}>
                {isCurrent && (
                  <span className={styles.currentLabel}>
                    当前
                  </span>
                )}
                <span className={styles.milestoneName} style={{ color: isCurrent ? "white" : "var(--ink)" }} title={m.name}>
                  {m.name}
                </span>
              </div>
              <div className={styles.metaLine}>
                <span className={styles.milestoneDate} style={{ color: isCurrent ? "rgba(255,255,255,.6)" : "var(--muted)" }}>
                  {formatDate(m.endDate)}
                </span>
                {!isPast && (
                  <span className={styles.countdown} style={{
                    color: isCurrent
                      ? (diff <= 7 ? "#fbbf24" : "rgba(255,255,255,.55)")
                      : (diff <= 7 ? "var(--danger)" : "var(--muted)"),
                  }}>
                    {diff === 0 ? "今天截止" : diff < 0 ? `已过期 ${-diff} 天` : `${diff} 天后`}
                  </span>
                )}
              </div>
            </div>
            <div className={styles.rowActions}>
              {canManage && (
                <button
                  className={styles.rowAction}
                  onClick={() => startEdit(m)}
                  style={{ color: isCurrent ? "rgba(255,255,255,.7)" : "var(--muted)" }}
                  title="编辑"
                >
                  编辑
                </button>
              )}
              {canDelete && (
                <button
                  className={`${styles.rowAction} ${styles.deleteAction}`}
                  onClick={() => deleteMilestone(m.id, m.name)}
                  style={{ color: isCurrent ? "rgba(255,255,255,.5)" : "var(--danger)40" }}
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
    <div className={styles.page}>
      <div className={styles.pageContent}>
        {/* Add form */}
        {canCreate && (
          <div className={styles.addCard}>
            <p className={styles.eyebrow}>New Milestone</p>
            <h2 className={styles.addTitle}>新增里程碑</h2>
            <div className={styles.addFields}>
              <input
                className={`${styles.input} ${styles.newNameInput}`}
                value={newName}
                onChange={e => { setNewName(e.target.value); setAddError(null); }}
                onKeyDown={e => { if (e.key === "Enter") addMilestone(); }}
                placeholder="里程碑名称，例如「首演」「联排开始」"
                onFocus={e => { e.currentTarget.style.borderColor = "var(--ink)"; }}
                onBlur={e => { e.currentTarget.style.borderColor = "var(--line)"; }}
              />
              <input
                className={`${styles.input} ${styles.newDateInput}`}
                type="date"
                value={newDate}
                onChange={e => { setNewDate(e.target.value); setAddError(null); }}
                onFocus={e => { e.currentTarget.style.borderColor = "var(--ink)"; }}
                onBlur={e => { e.currentTarget.style.borderColor = "var(--line)"; }}
              />
              <button
                className={styles.addButton}
                onClick={addMilestone}
                disabled={!newName.trim() || !newDate || adding}
                style={{
                  background: newName.trim() && newDate ? "var(--ink)" : "var(--line)",
                  color: newName.trim() && newDate ? "white" : "var(--muted)",
                  cursor: newName.trim() && newDate ? "pointer" : "default",
                }}
              >
                {adding ? "添加中…" : "添加"}
              </button>
            </div>
            {addError && <p className={styles.addError}>{addError}</p>}
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
