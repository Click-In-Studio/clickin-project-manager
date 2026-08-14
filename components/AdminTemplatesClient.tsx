"use client";

import { useMemo, useState } from "react";
import PageHeader, { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import Badge from "@/components/Badge";
import styles from "@/components/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";
import { CUE_LIST_TEMPLATES } from "@/lib/cue-list-types";

type Row = { deptId: string; template: string; canCreate: boolean; permissions: string[] };
type Dept = { id: string; name: string; kind: "dept" | "group" };

type Props = {
  productionId: string;
  productionName: string;
  depts: Dept[];
  initialRows: Row[];
  canEdit: boolean;
};

const SECTION_LABEL: React.CSSProperties = {
  margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
  textTransform: "uppercase", color: "var(--stage)",
};

// cue_list 相对键的常用面（自由输入仍允许）
const REL_SUBS = ["", "cues", "grants", "mounts"];
const REL_VERBS = ["view", "create", "edit", "delete"];

function RelKeyAdder({ busy, onAdd }: { busy: boolean; onAdd: (rel: string) => void }) {
  const [sub, setSub] = useState("");
  const [verb, setVerb] = useState("view");
  const FIELD: React.CSSProperties = {
    padding: "6px 8px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8,
    background: "var(--paper)", color: "var(--ink)",
  };
  const rel = `${sub}@${verb}`;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <select value={sub} onChange={e => setSub(e.target.value)} style={FIELD}>
        {REL_SUBS.map(s => <option key={s} value={s}>{s === "" ? "（主面）" : s}</option>)}
      </select>
      <select value={verb} onChange={e => setVerb(e.target.value)} style={FIELD}>
        {REL_VERBS.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
      <button style={{ ...PRIMARY_BTN, padding: "6px 11px" }} disabled={busy} onClick={() => onAdd(rel)}>添加键</button>
      <code style={{ fontSize: 10, color: "var(--muted)", background: "var(--surface-2)", padding: "3px 7px", borderRadius: 6 }}>{rel}</code>
    </div>
  );
}

export default function AdminTemplatesClient({ productionId, productionName, depts, initialRows, canEdit }: Props) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [selectedTemplate, setSelectedTemplate] = useState<string>(CUE_LIST_TEMPLATES[0]?.key ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addDeptId, setAddDeptId] = useState("");

  const deptMap = useMemo(() => new Map(depts.map(d => [d.id, d])), [depts]);
  const knownKeys = CUE_LIST_TEMPLATES.map(t => t.key);
  const customTemplates = [...new Set(rows.map(r => r.template).filter(t => !knownKeys.includes(t)))];
  const templateRows = rows.filter(r => r.template === selectedTemplate);
  const candidates = depts.filter(d => !templateRows.some(r => r.deptId === d.id));

  async function api(init: RequestInit): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cue-templates`, {
        headers: { "Content-Type": "application/json" }, ...init,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "操作失败"); return false; }
      return true;
    } catch { setError("网络错误"); return false; }
    finally { setBusy(false); }
  }

  async function upsert(row: Row) {
    if (await api({ method: "PUT", body: JSON.stringify(row) })) {
      setRows(prev => {
        const rest = prev.filter(r => !(r.deptId === row.deptId && r.template === row.template));
        return [...rest, row];
      });
    }
  }

  async function remove(row: Row) {
    if (!confirm(`确认删除「${deptMap.get(row.deptId)?.name ?? row.deptId}」的 ${row.template} 声明？存量表的实例区间键将被收回。`)) return;
    if (await api({ method: "DELETE", body: JSON.stringify({ deptId: row.deptId, template: row.template }) })) {
      setRows(prev => prev.filter(r => !(r.deptId === row.deptId && r.template === row.template)));
    }
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title="权限模版" side="stage" />

      {/* 摘要 */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(knownKeys.length + customTemplates.length), "Cue 表模版", "类型总数"],
          [String(rows.length), "声明行", "部门 × 模版"],
          [String(rows.filter(r => r.canCreate).length), "可建声明", "can_create 行"],
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

      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

      <section style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22,
        height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column",
      }}>
        <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
          <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
            {/* 左：模版类型 */}
            <div className={`${styles.splitPane} ${styles.splitList}`}>
              <div style={{ paddingRight: 16 }}>
                <p style={{ ...SECTION_LABEL, marginTop: 2 }}>Cue 表模版</p>
                {[...knownKeys, ...customTemplates].map(key => {
                  const active = selectedTemplate === key;
                  const n = rows.filter(r => r.template === key).length;
                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedTemplate(key)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        padding: "8px 10px", borderRadius: 9, border: "none", cursor: "pointer", textAlign: "left",
                        background: active ? "var(--ink)" : "transparent",
                      }}
                    >
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: active ? "#fff" : "var(--ink)" }}>{key}</span>
                      {!knownKeys.includes(key) && <Badge tone="amber">自定义</Badge>}
                      <span style={{ fontSize: 10, color: active ? "rgba(255,255,255,.6)" : "var(--muted)" }}>{n} 行</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 右：声明行 */}
            <div className={`${styles.splitPane} ${styles.splitDetail}`}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <h2 style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)" }}>
                  {selectedTemplate}
                </h2>
                <Badge tone="blue">声明 {templateRows.length}</Badge>
              </div>
              <p style={{ margin: "0 0 14px", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
                声明行 = 部门 × 模版：can_create 决定该部门成员能否建此类型 cue 表；
                相对键（如 @view、cues@edit）在每张同模版表创建时实例化为部门权限行。修改即时对存量表重算。
              </p>

              {templateRows.map(row => {
                const dept = deptMap.get(row.deptId);
                return (
                  <div key={row.deptId} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
                        {dept?.name ?? "（部门已删）"}
                        {dept?.kind === "group" && <span style={{ fontSize: 10, color: "var(--muted)" }}>（用户组）</span>}
                      </span>
                      {canEdit ? (
                        <button
                          disabled={busy}
                          onClick={() => upsert({ ...row, canCreate: !row.canCreate })}
                          style={{
                            padding: "3px 10px", borderRadius: 999, fontSize: 10, fontWeight: 700, cursor: "pointer",
                            border: "1px solid " + (row.canCreate ? "var(--success)" : "var(--line)"),
                            background: row.canCreate ? "var(--success-soft)" : "var(--paper)",
                            color: row.canCreate ? "var(--success)" : "var(--muted)",
                          }}
                        >
                          {row.canCreate ? "可建 ✓" : "不可建"}
                        </button>
                      ) : (
                        <Badge tone={row.canCreate ? "green" : "neutral"}>{row.canCreate ? "可建" : "不可建"}</Badge>
                      )}
                      {canEdit && (
                        <button
                          disabled={busy}
                          onClick={() => remove(row)}
                          style={{ ...SECONDARY_BTN, padding: "3px 9px", fontSize: 10, borderColor: "var(--danger)", color: "var(--danger)" }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: canEdit ? 8 : 0 }}>
                      {row.permissions.map(rel => (
                        <span key={rel} style={{
                          display: "inline-flex", alignItems: "center", gap: 5,
                          padding: "3px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700,
                          background: "var(--script-soft)", color: "var(--script)",
                        }}>
                          {rel}
                          {canEdit && (
                            <button
                              disabled={busy}
                              onClick={() => upsert({ ...row, permissions: row.permissions.filter(p => p !== rel) })}
                              style={{ border: "none", background: "transparent", cursor: "pointer", color: "inherit", padding: 0, fontSize: 11, lineHeight: 1 }}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                      {row.permissions.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)" }}>无受益键</span>}
                    </div>
                    {canEdit && (
                      <RelKeyAdder busy={busy} onAdd={rel => {
                        if (!row.permissions.includes(rel)) upsert({ ...row, permissions: [...row.permissions, rel] });
                      }} />
                    )}
                  </div>
                );
              })}
              {templateRows.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--muted)" }}>该模版暂无声明行</p>
              )}

              {canEdit && candidates.length > 0 && (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <select
                    value={addDeptId}
                    onChange={e => setAddDeptId(e.target.value)}
                    style={{ padding: "7px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", minWidth: 160 }}
                  >
                    <option value="">选择部门…</option>
                    {candidates.map(d => <option key={d.id} value={d.id}>{d.name}{d.kind === "group" ? "（组）" : ""}</option>)}
                  </select>
                  <button
                    style={PRIMARY_BTN}
                    disabled={busy || !addDeptId}
                    onClick={async () => {
                      await upsert({ deptId: addDeptId, template: selectedTemplate, canCreate: false, permissions: [] });
                      setAddDeptId("");
                    }}
                  >
                    ＋ 添加声明行
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
