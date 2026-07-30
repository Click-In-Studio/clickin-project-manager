"use client";

import { useState, useEffect, useRef } from "react";
import { BASE_PATH } from "@/lib/base-path";

const PRODUCTION_TYPES = [
  { value: "stage_play",    label: "话剧" },
  { value: "theatre",       label: "舞台剧" },
  { value: "musical",       label: "音乐剧" },
  { value: "gala",          label: "综合晚会" },
  { value: "music_festival",label: "音乐节" },
  { value: "concert",       label: "音乐会" },
  { value: "short_film",    label: "短片" },
  { value: "film",          label: "电影" },
  { value: "tv_drama",      label: "电视剧" },
  { value: "radio_drama",   label: "广播剧" },
  { value: "album",         label: "专辑" },
  { value: "other",         label: "其他" },
] as const;

const field: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--line)",
  borderRadius: 9,
  padding: "11px 14px",
  fontSize: 13,
  color: "var(--ink)",
  background: "var(--paper)",
  outline: "none",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

const selectField: React.CSSProperties = {
  ...field,
  appearance: "none",
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 12px center",
  paddingRight: 32,
  cursor: "pointer",
};

type Props = {
  onClose: () => void;
  onCreated: (id: string) => void;
};

export default function NewProductionModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [typeLabel, setTypeLabel] = useState("");
  const [language, setLanguage] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  async function submit() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          type: type || undefined,
          typeLabel: type === "other" ? (typeLabel.trim() || undefined) : undefined,
          language: language.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "创建失败"); return; }
      onCreated(data.id);
    } catch {
      setError("网络错误，请重试");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      role="presentation"
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "0 16px",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-prod-title"
        style={{
          width: "min(520px, 100%)",
          background: "var(--surface)",
          borderRadius: 16,
          boxShadow: "0 24px 80px rgba(24,42,42,.22)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "24px 28px 20px",
          borderBottom: "1px solid var(--line)",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        }}>
          <div>
            <p style={{
              margin: "0 0 4px", fontSize: 9, fontWeight: 700,
              letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)",
            }}>
              NEW PRODUCTION
            </p>
            <h2 id="new-prod-title" style={{
              margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif',
              fontSize: 22, fontWeight: 500, color: "var(--ink)",
            }}>
              新建项目
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              border: 0, background: "transparent", cursor: "pointer",
              fontSize: 20, color: "var(--muted)", lineHeight: 1, padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Name */}
          <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".04em" }}>
              项目名称 <span style={{ color: "var(--danger)" }}>*</span>
            </span>
            <input
              ref={nameRef}
              value={name}
              onChange={e => { setName(e.target.value); setError(""); }}
              onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="例：《海边的罗密欧》2025 首演"
              style={field}
            />
          </label>

          {/* Type */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".04em" }}>项目类型</span>
              <select
                value={type}
                onChange={e => { setType(e.target.value); if (e.target.value !== "other") setTypeLabel(""); }}
                style={selectField}
              >
                <option value="">— 不指定 —</option>
                {PRODUCTION_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".04em" }}>语言</span>
              <input
                value={language}
                onChange={e => setLanguage(e.target.value)}
                placeholder="普通话 / English"
                style={field}
              />
            </label>
          </div>

          {/* Other type label */}
          {type === "other" && (
            <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".04em" }}>自定义类型名称</span>
              <input
                value={typeLabel}
                onChange={e => setTypeLabel(e.target.value)}
                placeholder="输入类型名称"
                style={field}
              />
            </label>
          )}

          {/* Description */}
          <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".04em" }}>简介</span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="项目简要说明（可选）"
              rows={3}
              style={{ ...field, resize: "vertical" }}
            />
          </label>

          {error && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{error}</p>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "12px 28px 24px",
          display: "flex", justifyContent: "flex-end", gap: 10,
        }}>
          <button
            onClick={onClose}
            style={{
              border: "1px solid var(--line)", borderRadius: 9, padding: "10px 18px",
              background: "transparent", color: "var(--muted)",
              fontSize: 13, cursor: "pointer",
            }}
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || creating}
            style={{
              border: "1px solid var(--ink)", borderRadius: 9, padding: "10px 22px",
              background: "var(--ink)", color: "#fff",
              fontSize: 13, fontWeight: 700, cursor: "pointer",
              opacity: !name.trim() || creating ? 0.4 : 1,
              transition: "opacity .1s",
            }}
          >
            {creating ? "创建中…" : "创建项目 →"}
          </button>
        </div>
      </section>
    </div>
  );
}
