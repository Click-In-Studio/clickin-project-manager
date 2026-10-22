"use client";

import { useEffect, useState } from "react";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { MEMORY_ENTRY_MAX, type MemoryEntry, type MemoryScopeView } from "@/lib/agent/memory/memory-types";
import styles from "./memory-settings.module.css";

type Mutation = { action: "create" | "update" | "delete" | "restore"; id?: string; body?: string; revision?: number };
function MemoryEditor({ entry, busy, onChange }: { entry: MemoryEntry; busy: boolean; onChange: (change: Mutation) => Promise<boolean> }) {
  const [draft, setDraft] = useState(entry.body);
  useEffect(() => { setDraft(entry.body); }, [entry.body]);
  return <li className={styles.entry}>
    <div className={styles.meta}>
      <span>{entry.deletedAt ? "已删除" : "协作记忆"}</span>
      <span>{entry.userEdited ? "用户编辑" : "AI 记录"}</span>
      <span>记录于 {new Date(entry.createdAt).toLocaleString("zh-CN")}</span>
    </div>
    <textarea aria-label="记忆内容" value={draft} maxLength={MEMORY_ENTRY_MAX} disabled={busy || !!entry.deletedAt}
      onChange={e => setDraft(e.target.value)} rows={3} />
    <div className={styles.actions}>
      <button type="button" disabled={busy || !!entry.deletedAt || !draft.trim() || draft === entry.body}
        onClick={() => void onChange({ action: "update", id: entry.id, body: draft, revision: entry.revision })}>保存修改</button>
      {entry.deletedAt ? <button type="button" disabled={busy} onClick={() => void onChange({ action: "restore", id: entry.id, revision: entry.revision })}>恢复</button> : <button type="button" disabled={busy} onClick={() => {
        if (window.confirm("删除这条记忆？后续不再作为有效记忆使用，可在已删除列表恢复。此前历史退出本范围检索，请开启新对话形成新的记忆。")) {
          void onChange({ action: "delete", id: entry.id, revision: entry.revision });
        }
      }}>删除</button>}
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
    <p className={styles.explanation}>助理会主动维护个人记忆，无需逐条确认。近期记忆默认提醒，久未使用的仍可查找；重复和分歧会一起核对。你修改的条目不会被 AI 覆盖，删除后可以恢复。</p>
    {error && <div><p role="alert">{error}</p><button type="button" disabled={busy} onClick={() => setReload(n => n + 1)}>重新加载</button></div>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">正在加载记忆…</p>}
    {memory && <>
      {memory.historyCutoff && <p className={styles.explanation}>此前历史已于 {new Date(memory.historyCutoff).toLocaleString("zh-CN")} 退出此范围的记忆。</p>}
      <ul className={styles.list}>
        {memory.entries.map(e => <MemoryEditor key={e.id} entry={e} busy={busy} onChange={mutate} />)}
      </ul>
      {!memory.entries.length && <p>暂无条目</p>}
      {!!memory.deletedEntries?.length && <details><summary>已删除的记忆</summary><ul className={styles.list}>
        {memory.deletedEntries.map(e => <MemoryEditor key={e.id} entry={e} busy={busy} onChange={mutate} />)}
      </ul></details>}
      <label className={styles.add}>添加我的要求
        <textarea aria-label="新增记忆内容" value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} maxLength={MEMORY_ENTRY_MAX} rows={3} />
      </label>
      <button type="button" disabled={busy || !draft.trim()} onClick={() => {
        void mutate({ action: "create", body: draft }).then(ok => { if (ok) setDraft(""); });
      }}>添加记忆</button>
    </>}
  </section>;
}
