"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";
import { ymd } from "./date";
import { phaseTone, phaseRangeLabel } from "./phase";
import type { PlanningMilestone, PlanningDept, PlanningPhase, PhasePerm } from "./types";

export default function PhaseManageModal({
  productionId, phases, milestones, deptOptions, perm, onClose,
}: {
  productionId: string;
  phases: PlanningPhase[];
  milestones: PlanningMilestone[];
  deptOptions: PlanningDept[];
  perm: PhasePerm;
  onClose: () => void;
}) {
  const router = useRouter();
  const today = ymd(new Date());

  // null = 未在编辑；"new" = 创建表单；否则为 phase id
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deptId, setDeptId] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [milestoneIds, setMilestoneIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pocOnly = !perm.canCreate;
  // 创建时的归属候选：有 phase 键 ⇒ 全项目 + 任意部门；仅 POC 路径 ⇒ 只有自己 POC 的部门
  const createDeptChoices = pocOnly
    ? deptOptions.filter(d => perm.pocDeptIds.includes(d.id))
    : deptOptions;

  const canEditPhase = (p: PlanningPhase) =>
    perm.canEdit || (p.deptId !== null && perm.deptPocEnabled && perm.pocDeptIds.includes(p.deptId));
  const canDeletePhase = (p: PlanningPhase) =>
    perm.canDelete || (p.deptId !== null && perm.deptPocEnabled && perm.pocDeptIds.includes(p.deptId));
  const canCreateAny = perm.canCreate || (perm.deptPocEnabled && createDeptChoices.length > 0);

  function startCreate() {
    setEditing("new");
    setName("");
    setDeptId(pocOnly ? (createDeptChoices[0]?.id ?? "") : "");
    setStartDate(today);
    setEndDate("");
    setMilestoneIds(new Set());
    setError(null);
  }

  function startEdit(p: PlanningPhase) {
    setEditing(p.id);
    setName(p.name);
    setDeptId(p.deptId ?? "");
    setStartDate(p.startDate);
    setEndDate(p.endDate ?? "");
    setMilestoneIds(new Set(p.milestoneIds));
    setError(null);
  }

  async function submit() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const isNew = editing === "new";
      const url = isNew
        ? `${BASE_PATH}/api/production/${productionId}/phases`
        : `${BASE_PATH}/api/production/${productionId}/phases/${editing}`;
      const payload: Record<string, unknown> = {
        name: name.trim(),
        startDate: startDate || undefined,
        endDate: endDate || null,
        milestoneIds: [...milestoneIds],
      };
      if (isNew) payload.deptId = deptId || null;  // 归属只在创建时定（编辑面不换轨）
      const res = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error ?? "保存失败"); return; }
      setEditing(null);
      router.refresh();
    } catch {
      setError("网络错误，保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: PlanningPhase) {
    if (!confirm(`删除阶段「${p.name}」？绑定的任务与里程碑不受影响。`)) return;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/phases/${p.id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
    else {
      const data = await res.json().catch(() => null);
      alert(data?.error ?? "删除失败");
    }
  }

  const formBlock = (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 10, border: "1px solid var(--line)", background: "var(--paper)" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
          placeholder="阶段名称，例如「排练期」「装台与技排」"
          style={{ flex: 1, minWidth: 150, fontSize: 12, color: "var(--ink)", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", outline: "none" }}
        />
        {editing === "new" && (
          <OverflowSafeSelect
            value={deptId}
            onChange={e => setDeptId(e.target.value)}
            style={{ fontSize: 12, color: "var(--ink)", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", outline: "none" }}
          >
            {!pocOnly && <option value="">全项目</option>}
            {createDeptChoices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </OverflowSafeSelect>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
          开始
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            style={{ fontSize: 12, color: "var(--ink)", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 10px", outline: "none" }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
          结束
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            style={{ fontSize: 12, color: "var(--ink)", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 10px", outline: "none" }} />
          <span style={{ fontSize: 10 }}>留空 = 未定</span>
        </label>
      </div>
      {milestones.length > 0 && (
        <div>
          <span style={{ display: "block", marginBottom: 5, fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)" }}>
            关联里程碑（可多选）
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {milestones.map(m => {
              const active = milestoneIds.has(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setMilestoneIds(prev => {
                    const next = new Set(prev);
                    if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                    return next;
                  })}
                  style={{
                    border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
                    borderRadius: 999, padding: "4px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer",
                    background: active ? "var(--ink)" : "var(--surface)",
                    color: active ? "#fff" : "var(--muted)",
                  }}
                >
                  ◆ {m.name} · {m.endDate.slice(5, 10).replace("-", "/")}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {error && <p style={{ margin: 0, fontSize: 11, color: "var(--danger)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={() => setEditing(null)} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "6px 10px" }}>取消</button>
        <button
          onClick={submit}
          disabled={!name.trim() || !startDate || saving}
          style={{
            fontSize: 12, fontWeight: 700, padding: "6px 16px", borderRadius: 8, border: "none",
            background: name.trim() ? "var(--ink)" : "var(--line)",
            color: name.trim() ? "#fff" : "var(--muted)",
            cursor: name.trim() ? "pointer" : "default",
          }}
        >
          {saving ? "保存中…" : editing === "new" ? "创建" : "保存"}
        </button>
      </div>
    </div>
  );

  return (
    <div
      role="presentation"
      onMouseDown={onClose}
      style={{ position: "fixed", zIndex: 80, inset: 0, background: "rgba(18,28,27,.65)", display: "grid", placeItems: "center", padding: 20 }}
    >
      <div
        role="dialog"
        aria-label="管理阶段"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: "min(640px, 100%)", maxHeight: "84vh", overflowY: "auto", background: "var(--surface)", borderRadius: 13, border: "1px solid var(--line)", padding: 22, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div>
            <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>Phases</p>
            <h2 style={{ margin: "4px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 18, fontWeight: 500, color: "var(--ink)" }}>管理阶段</h2>
          </div>
          <button onClick={onClose} aria-label="关闭" style={{ marginLeft: "auto", border: 0, background: "none", color: "var(--muted)", fontSize: 16, cursor: "pointer" }}>✕</button>
        </div>

        {editing === "new" && formBlock}
        {editing === null && canCreateAny && (
          <button
            onClick={startCreate}
            style={{ alignSelf: "flex-start", fontSize: 12, fontWeight: 700, padding: "7px 14px", borderRadius: 8, border: "1px dashed var(--line)", background: "var(--paper)", color: "var(--ink)", cursor: "pointer" }}
          >
            ＋ 新增阶段
          </button>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {phases.length === 0 && editing !== "new" && (
            <p style={{ margin: 0, padding: "24px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
              暂无阶段。{canCreateAny ? "点击「新增阶段」创建第一个项目大阶段。" : ""}
            </p>
          )}
          {phases.map((p, pi) => {
            const tone = phaseTone(pi);
            if (editing === p.id) return <div key={p.id}>{formBlock}</div>;
            return (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--paper)" }}>
                <i style={{ width: 10, height: 10, borderRadius: 3, background: tone.solid, opacity: .7, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ display: "block", fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                    <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 400, color: "var(--muted)" }}>{p.deptName ?? "全项目"}</span>
                  </b>
                  <small style={{ fontSize: 10, color: "var(--muted)" }}>
                    {phaseRangeLabel(p)}
                    {p.milestoneIds.length > 0 && ` · ◆ ${p.milestoneIds.length} 个里程碑`}
                  </small>
                </div>
                {canEditPhase(p) && (
                  <button onClick={() => startEdit(p)} style={{ fontSize: 11, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: "4px 6px" }}>编辑</button>
                )}
                {canDeletePhase(p) && (
                  <button onClick={() => remove(p)} style={{ fontSize: 11, color: "var(--danger)", background: "none", border: "none", cursor: "pointer", padding: "4px 6px" }}>删除</button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
