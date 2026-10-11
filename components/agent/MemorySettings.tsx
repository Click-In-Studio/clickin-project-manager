"use client";

import { useEffect, useState } from "react";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { MEMORY_ENTRY_MAX, type MemoryEntry, type MemoryScopeView } from "@/lib/agent/memory/memory-types";
import styles from "./memory-settings.module.css";

type Mutation = { action: "create" | "update" | "delete"; id?: string; body?: string; revision?: number };
function MemoryEditor({ entry, busy, onChange }: { entry: MemoryEntry; busy: boolean; onChange: (change: Mutation) => Promise<boolean> }) {
  const [draft, setDraft] = useState(entry.body);
  useEffect(() => { setDraft(entry.body); }, [entry.body]);
  return <li className={styles.entry}>
    <div className={styles.meta}>
      <span>{entry.source === "dream" ? "自动整理" : "主动记录"}</span>
      <span>{entry.userEdited ? "用户编辑" : "AI 记录 · 未经用户确认"}</span>
      {entry.inputCount > 0 && <span>整理时使用 {entry.inputCount} 条历史摘要 · 不代表逐条证据</span>}
    </div>
    <textarea aria-label="记忆内容" value={draft} maxLength={MEMORY_ENTRY_MAX} disabled={busy}
      onChange={e => setDraft(e.target.value)} rows={3} />
    <div className={styles.actions}>
      <button type="button" disabled={busy || !draft.trim() || draft === entry.body}
        onClick={() => void onChange({ action: "update", id: entry.id, body: draft, revision: entry.revision })}>保存修改</button>
      <button type="button" disabled={busy} onClick={() => {
        if (window.confirm("删除这条记忆？该范围此前的历史将不再用于整理或检索，该范围其他已有条目会保留；用过此项目历史的通用自动摘要也会退出，用户编辑和主动条目保留。请开启新对话形成新记忆；原会话仍可聊天，但不再作为此范围的记忆来源。")) {
          void onChange({ action: "delete", id: entry.id, revision: entry.revision });
        }
      }}>删除</button>
    </div>
  </li>;
}

export default function MemorySettings() {
  const [reload, setReload] = useState(0);
  const [scope, setScope] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [memory, setMemory] = useState<MemoryScopeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setMemory(null); setError(""); setNotice(""); setDraft("");
    void fetch(`/api/account/memories${scope ? `?productionId=${encodeURIComponent(scope)}` : ""}`, { signal: controller.signal, cache: "no-store" })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "加载失败");
        if (controller.signal.aborted) return;
        setMemory(data.memory); setProjects(data.projects);
      }).catch(err => { if (!controller.signal.aborted) setError(err.message ?? "加载失败，请重试"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [scope, reload]);

  async function mutate(change: Mutation): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/account/memories", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...change, productionId: scope || null }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存失败，请重试");
      setMemory(data.memory);
      setNotice(change.action === "delete" ? "已删除，旧历史不会再用于这个范围的记忆。" : "已保存，后续对话会使用修改后的内容。");
      return true;
    } catch (err) { setError(err instanceof Error ? err.message : "网络错误，请重试"); return false; }
    finally { setBusy(false); }
  }

  return <section className={styles.panel} aria-label="我的长期记忆">
    <h2>我的长期记忆</h2>
    <p>通用记忆用于个人和项目对话；项目记忆只用于你在该项目中的对话。当前要求始终优先于旧记忆。</p>
    <label className={styles.scope}>记忆范围
      <OverflowSafeSelect value={scope} disabled={busy} onChange={e => setScope(e.target.value)}>
        <option value="">个人通用</option>
        {projects.map(p => <option key={p.id} value={p.id}>{p.name} · 我的项目记忆</option>)}
      </OverflowSafeSelect>
    </label>
    <p className={styles.explanation}>修改或删除会让该范围此前的历史退出整理和检索，该范围其他已有记忆会保留；若通用自动摘要用过此项目历史，那组未编辑的摘要也会退出，用户编辑和主动条目保留。开启新对话后，重新表达的要求仍可被记住；原会话不再作为此范围的记忆来源。</p>
    {error && <div><p role="alert">{error}</p><button type="button" disabled={busy} onClick={() => setReload(n => n + 1)}>重新加载</button></div>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">正在加载记忆…</p>}
    {memory && <>
      {memory.historyCutoff && <p className={styles.explanation}>此前历史已于 {new Date(memory.historyCutoff).toLocaleString("zh-CN")} 退出此范围的记忆。</p>}
      {(["dream", "active"] as const).map(source => <section key={source}>
        <h3>{source === "dream" ? "自动整理" : "主动记录"}</h3>
        <p>{source === "dream" ? "AI 从历史摘要整理出的持续偏好和要求。" : "及时记录的协作要求，自动整理不会覆盖这些条目。"}</p>
        <ul className={styles.list}>
          {memory.entries.filter(e => e.source === source).map(e => <MemoryEditor key={e.id} entry={e} busy={busy} onChange={mutate} />)}
        </ul>
        {!memory.entries.some(e => e.source === source) && <p>暂无条目</p>}
      </section>)}
      <label className={styles.add}>添加我的要求
        <textarea aria-label="新增记忆内容" value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} maxLength={MEMORY_ENTRY_MAX} rows={3} />
      </label>
      <button type="button" disabled={busy || !draft.trim()} onClick={() => {
        void mutate({ action: "create", body: draft }).then(ok => { if (ok) setDraft(""); });
      }}>添加记忆</button>
    </>}
  </section>;
}
