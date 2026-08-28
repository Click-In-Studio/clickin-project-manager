"use client";

import OverflowSafeSelect from "@/components/OverflowSafeSelect";

import { useMemo, useState } from "react";
import PageHeader from "@/components/PageHeader";
import Badge from "@/components/Badge";
import styles from "@/components/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";

/** 与 GET /api/production/[id]/policies 的返回对齐。 */
type Disposition =
  | { kind: "actor"; label: string }
  | { kind: "scope"; label: string }
  | { kind: "fallback" }
  | { kind: "closesFeature" };

type Answer = { id: string; label: string; values: Record<string, string>; disposition: Disposition[] };
type Question = {
  id: string; group: string; title: string; help: string | null; danger: boolean;
  answers: Answer[];
  answerId: string | null;
};
type PolicyRow = {
  key: string; value: string; shape: "A" | "C" | "L";
  values: readonly string[]; defaultValue: string; isDefault: boolean;
  label: string; help: string;
};
type AuditRow = {
  policyKey: string; oldValue: string; newValue: string;
  changedBy: string | null; changedAt: string;
};

type Props = {
  productionId: string;
  productionName: string;
  initialPolicies: PolicyRow[];
  initialQuestions: Question[];
  advancedOnly: string[];
  initialAudit: AuditRow[];
  canEdit: boolean;
};

const SECTION_LABEL: React.CSSProperties = {
  margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
  textTransform: "uppercase", color: "var(--stage)",
};

/** 「选了这一档之后，这件事还能被谁做」——常量的一部分，不是文案。 */
function dispositionText(ds: Disposition[]): string {
  if (ds.some((d) => d.kind === "closesFeature")) return "该功能整体关闭，没有人能做";
  const who = ds.flatMap((d) => (d.kind === "actor" || d.kind === "scope" ? [d.label] : []));
  const tail = ds.some((d) => d.kind === "fallback") ? "；否则兜底在制作人" : "";
  return who.length ? `仍可：${who.join(" · ")}${tail}` : `仅剩兜底${tail}`;
}

const ADVANCED_GROUPS = ["常用设置涉及", "仅高级可配"] as const;

export default function AdminPoliciesClient({
  productionId, productionName, initialPolicies, initialQuestions,
  advancedOnly, initialAudit, canEdit,
}: Props) {
  const [tab, setTab] = useState<"simple" | "advanced" | "audit">("simple");
  const [policies, setPolicies] = useState(initialPolicies);
  const [questions, setQuestions] = useState(initialQuestions);
  const [audit, setAudit] = useState(initialAudit);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = useMemo(() => {
    const m = new Map(policies.map((p) => [p.key, p.value]));
    for (const [k, v] of Object.entries(pending)) m.set(k, v);
    return m;
  }, [policies, pending]);

  /** 命中的答案本地实时算——双视图是同一份数据的两个面，不各存一份。 */
  const answerOf = (q: Question): string | null =>
    q.answers.find((a) => Object.entries(a.values).every(([k, v]) => current.get(k) === v))?.id ?? null;

  const groups = useMemo(() => {
    const m = new Map<string, Question[]>();
    for (const q of questions) m.set(q.group, [...(m.get(q.group) ?? []), q]);
    return [...m.entries()];
  }, [questions]);

  const advancedSet = useMemo(() => new Set(advancedOnly), [advancedOnly]);
  const advGroups = useMemo(() => ([
    ["常用设置涉及", policies.filter((p) => !advancedSet.has(p.key))],
    ["仅高级可配", policies.filter((p) => advancedSet.has(p.key))],
  ] as [string, PolicyRow[]][]), [policies, advancedSet]);

  const [simpleGroup, setSimpleGroup] = useState(groups[0]?.[0] ?? "");
  const [advGroup, setAdvGroup] = useState<string>(ADVANCED_GROUPS[0]);

  const changedCount = policies.filter((p) => (current.get(p.key) ?? p.value) !== p.defaultValue).length;
  const customCount = questions.filter((q) => answerOf(q) === null).length;
  const dirty = Object.keys(pending).length;

  const pickAnswer = (a: Answer): void => setPending((p) => ({ ...p, ...a.values }));
  const setKey = (key: string, value: string): void => setPending((p) => ({ ...p, [key]: value }));

  async function save(): Promise<void> {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/policies`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ changes: pending }),
      });
      if (!res.ok) {
        setError(((await res.json()) as { error?: string }).error ?? "保存失败");
        return;
      }
      const fresh = await fetch(
        `${BASE_PATH}/api/production/${productionId}/policies?audit=1`, { cache: "no-store" });
      const body = await fresh.json() as { policies: PolicyRow[]; questions: Question[]; audit: AuditRow[] };
      setPolicies(body.policies); setQuestions(body.questions); setAudit(body.audit);
      setPending({});
    } catch {
      setError("网络错误");
    } finally {
      setSaving(false);
    }
  }

  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "7px 0", borderRadius: 8, border: "none", cursor: "pointer",
    fontSize: 12, fontWeight: 700,
    background: active ? "var(--ink)" : "transparent",
    color: active ? "#fff" : "var(--muted)",
  });

  const listBtn = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "8px 10px", borderRadius: 9, border: "none", cursor: "pointer", textAlign: "left",
    background: active ? "var(--ink)" : "transparent",
  });

  const listLabel = (active: boolean): React.CSSProperties => ({
    flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600,
    color: active ? "#fff" : "var(--ink)",
  });

  const shownQuestions = groups.find(([g]) => g === simpleGroup)?.[1] ?? [];
  const shownKeys = advGroups.find(([g]) => g === advGroup)?.[1] ?? [];

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title="策略中心" side="stage" />

      {/* 摘要 */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(changedCount), "已偏离默认", `共 ${policies.length} 项`],
          [String(customCount), "自定义组合", `共 ${questions.length} 道设置题`],
          [audit[0] ? audit[0].changedAt.slice(5, 10) : "—", "最近改动", audit.length ? `近 ${audit.length} 条记录` : "尚无改动"],
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

      {/* segmented */}
      <div style={{ display: "flex", gap: 4, padding: 4, background: "var(--surface-2)", borderRadius: 10, width: 360, marginBottom: 14 }}>
        <button style={segBtn(tab === "simple")} onClick={() => setTab("simple")}>常用设置</button>
        <button style={segBtn(tab === "advanced")} onClick={() => setTab("advanced")}>高级（逐项）</button>
        <button style={segBtn(tab === "audit")} onClick={() => setTab("audit")}>改动记录</button>
      </div>

      <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--muted)", maxWidth: 760, lineHeight: 1.7 }}>
        这里配置的是「默认自动授权」的开合。已经通过角色或部门被授权的人不受影响——他们走的是另一条通道。
      </p>

      {!canEdit && (
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--warn)", fontWeight: 700 }}>
          你只有查看权限，改动需要项目设置的编辑权。
        </p>
      )}
      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

      <section style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22,
        height: "calc(100vh - 380px)", minHeight: 440, display: "flex", flexDirection: "column",
      }}>
        {tab === "audit" ? (
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            {audit.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--muted)" }}>尚无改动记录。</p>
            ) : audit.map((a, i) => (
              <div key={i} style={{
                display: "flex", gap: 12, alignItems: "center", padding: "9px 0",
                borderBottom: "1px solid var(--line)", fontSize: 12,
              }}>
                <span style={{ color: "var(--muted)", whiteSpace: "nowrap", fontSize: 11 }}>
                  {a.changedAt.slice(0, 16).replace("T", " ")}
                </span>
                <code style={{ flex: 1, minWidth: 0, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.policyKey}
                </code>
                <span style={{ color: "var(--muted)", fontSize: 11, whiteSpace: "nowrap" }}>
                  {a.oldValue} → <b style={{ color: "var(--ink)" }}>{a.newValue}</b>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
            <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
              {/* 左栏：分组 */}
              <div className={`${styles.splitPane} ${styles.splitList}`}>
                <div style={{ paddingRight: 16 }}>
                  <p style={SECTION_LABEL}>{tab === "simple" ? "分组" : "范围"}</p>
                  {(tab === "simple"
                    ? groups.map(([g, qs]) => [g, qs.filter((q) => answerOf(q) === null).length, qs.length] as const)
                    : advGroups.map(([g, ks]) => [g, ks.filter((p) => (current.get(p.key) ?? p.value) !== p.defaultValue).length, ks.length] as const)
                  ).map(([g, badge, total]) => {
                    const active = (tab === "simple" ? simpleGroup : advGroup) === g;
                    return (
                      <button key={g} style={listBtn(active)}
                        onClick={() => (tab === "simple" ? setSimpleGroup(g) : setAdvGroup(g))}>
                        <span style={listLabel(active)}>{g}</span>
                        {badge > 0 && <Badge tone="amber">{badge}</Badge>}
                        <span style={{ fontSize: 10, color: active ? "rgba(255,255,255,.6)" : "var(--muted)" }}>{total}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 右栏：详情 */}
              <div className={`${styles.splitPane} ${styles.splitDetail}`}>
                {tab === "simple" ? shownQuestions.map((q) => {
                  const picked = answerOf(q);
                  return (
                    <div key={q.id} style={{ marginBottom: 22 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <b style={{ fontSize: 13, color: "var(--ink)" }}>{q.title}</b>
                        {q.danger && <Badge tone="red">对外</Badge>}
                        {picked === null && <Badge tone="amber">自定义</Badge>}
                      </div>
                      {q.help && (
                        <p style={{ margin: "5px 0 0", fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>{q.help}</p>
                      )}
                      {picked === null && (
                        <p style={{ margin: "5px 0 0", fontSize: 11, color: "var(--warn)", lineHeight: 1.7 }}>
                          当前是在「高级」里逐项改出来的，不对应下面任何一档。选中任意一档会覆盖这道题涉及的全部设置。
                        </p>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                        {q.answers.map((a) => {
                          const on = picked === a.id;
                          return (
                            <button key={a.id} disabled={!canEdit} onClick={() => pickAnswer(a)}
                              style={{
                                textAlign: "left", cursor: canEdit ? "pointer" : "default",
                                border: `1px solid ${on ? "var(--ink)" : "var(--line)"}`,
                                background: on ? "var(--ink)" : "var(--paper)",
                                borderRadius: 9, padding: "9px 11px",
                              }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: on ? "#fff" : "var(--ink)" }}>
                                {a.label}
                              </div>
                              <div style={{ fontSize: 10, marginTop: 3, color: on ? "rgba(255,255,255,.7)" : "var(--muted)" }}>
                                {dispositionText(a.disposition)}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                }) : (
                  <>
                    {advGroup === "仅高级可配" && (
                      <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>
                        这些项没有出现在「常用设置」里——多数关掉会让基本流程走不通（比如被拉进事件的人看不到事件）。确有需要再改。
                      </p>
                    )}
                    {shownKeys.map((p) => {
                      const v = current.get(p.key) ?? p.value;
                      return (
                        <div key={p.key} style={{
                          display: "flex", gap: 12, alignItems: "flex-start",
                          padding: "10px 0", borderBottom: "1px solid var(--line)",
                        }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{p.label}</span>
                              {v !== p.defaultValue && <Badge tone="amber">已改</Badge>}
                            </div>
                            <p style={{ margin: "3px 0 0", fontSize: 10, color: "var(--muted)", lineHeight: 1.7 }}>{p.help}</p>
                            <code style={{ fontSize: 9, color: "var(--muted)" }}>{p.key}</code>
                          </div>
                          <OverflowSafeSelect value={v} disabled={!canEdit}
                            onChange={(e) => setKey(p.key, e.target.value)}
                            style={{
                              padding: "6px 8px", fontSize: 11, borderRadius: 8,
                              border: "1px solid var(--line)", background: "var(--paper)", color: "var(--ink)",
                            }}>
                            {p.values.map((opt) => (
                              <option key={opt} value={opt}>{opt === p.defaultValue ? `${opt}（默认）` : opt}</option>
                            ))}
                          </OverflowSafeSelect>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {dirty > 0 && canEdit && (
          <div style={{
            display: "flex", gap: 10, alignItems: "center",
            borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12,
          }}>
            <span style={{ fontSize: 11, color: "var(--muted)", flex: 1 }}>{dirty} 项待保存</span>
            <button disabled={saving} onClick={() => { setPending({}); setError(null); }}
              style={{
                padding: "7px 14px", borderRadius: 8, border: "1px solid var(--line)",
                background: "transparent", color: "var(--ink)", fontSize: 12, cursor: "pointer",
              }}>放弃</button>
            <button disabled={saving} onClick={save}
              style={{
                padding: "7px 14px", borderRadius: 8, border: "1px solid var(--ink)",
                background: "var(--ink)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}>{saving ? "保存中…" : "保存"}</button>
          </div>
        )}
      </section>
    </div>
  );
}
