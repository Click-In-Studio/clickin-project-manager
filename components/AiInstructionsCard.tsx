"use client";

// 制作级 agents.md 编辑卡（制作设置页）。写给 AI 助手、对本制作全体成员的
// 会话生效的指令。权限：ai_instructions/*@edit（制作人经模版类型通配覆盖，
// POC 无此键）——无权限时父组件整节不渲染，这里不再判。样式对齐
// AdminSettingsClient 的 Card 惯例（白底圆角 + uppercase 小标题）。

import { useEffect, useState } from "react";

export default function AiInstructionsCard({ productionId }: { productionId: string }) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/agent/instructions?productionId=${encodeURIComponent(productionId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { production?: { content: string | null } } | null) => {
        if (!alive) return;
        setText(data?.production?.content ?? "");
        setLoaded(true);
      })
      .catch(() => {
        if (alive) {
          setError("读取失败，刷新页面重试");
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [productionId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/agent/instructions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "production", productionId, content: text }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const err = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setError(err.error || "保存失败，请重试");
      return;
    }
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ background: "white", borderRadius: 12, overflow: "hidden", border: "1px solid var(--line)", marginBottom: 20 }}>
      <div style={{ padding: "14px 24px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".07em", textTransform: "uppercase" }}>
          AI 助手指令
        </p>
      </div>
      <div style={{ padding: "16px 24px 20px" }}>
        <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
          写给 AI 助手的制作级指令，对本制作全体成员的 AI 会话生效（如本制作的术语约定、
          cue 命名规则、回复口径）。与成员个人指令冲突时以这里为准；指令不改变任何人的权限。
        </p>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          disabled={!loaded || saving}
          maxLength={4000}
          rows={8}
          placeholder="例如：本制作的角色名一律用剧本原文写法；涉及排期回答时先看里程碑…"
          style={{
            width: "100%", resize: "vertical", borderRadius: 8, border: "1px solid var(--line)",
            padding: "8px 12px", fontSize: 13, fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            {text.length}/4000{error ? ` · ${error}` : saved ? " · 已保存" : ""}
          </span>
          <button
            onClick={save}
            disabled={!dirty || saving}
            style={{
              borderRadius: 8, padding: "6px 16px", fontSize: 13, border: "none",
              background: dirty ? "var(--ink)" : "var(--line)", color: dirty ? "white" : "var(--muted)",
              cursor: dirty && !saving ? "pointer" : "default",
            }}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
