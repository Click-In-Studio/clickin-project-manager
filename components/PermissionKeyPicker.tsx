"use client";

import { useEffect, useMemo, useState } from "react";
import { PRIMARY_BTN } from "@/components/PageHeader";
import { BASE_PATH } from "@/lib/base-path";
import { typeLabel, subLabel, verbLabel } from "@/lib/permission-labels";

export type Vocabulary = {
  verbs: Record<string, string[]>;
  subs: Record<string, string[]>;
};

const CUSTOM = "__custom__";
// 保留段等常用面，词汇聚合可能未覆盖时兜底
const COMMON_SUBS = ["*", "meta", "grants", "publication", "imports", "mounts"];

/**
 * 权限键选择器：资源类型 → 资源实例 → 面 → 动词 全下拉（中文翻译展示，
 * 值提交英文原文），输出 node:type/id[/sub]@verb。
 * 实例下拉由 resource-directory API 供给；面/实例支持「自定义…」自由输入。
 */
export default function PermissionKeyPicker({
  vocabulary, productionId, onAdd, busy, verbFilter,
}: {
  vocabulary: Vocabulary;
  productionId: string;
  onAdd: (key: string) => void | Promise<void>;
  busy?: boolean;
  /** 限制可选动词 */
  verbFilter?: (verb: string) => boolean;
}) {
  const types = useMemo(() => Object.keys(vocabulary.verbs).sort(), [vocabulary]);
  const [type, setType] = useState("");
  const [resId, setResId] = useState("*");
  const [customId, setCustomId] = useState("");
  const [sub, setSub] = useState("*");
  const [customSub, setCustomSub] = useState("");
  const [verb, setVerb] = useState("");
  const [directory, setDirectory] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    setResId("*"); setCustomId(""); setSub("*"); setCustomSub(""); setVerb("");
    setDirectory([]);
    if (!type) return;
    let cancelled = false;
    fetch(`${BASE_PATH}/api/production/${productionId}/resource-directory?type=${encodeURIComponent(type)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled && Array.isArray(d.items)) setDirectory(d.items); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [type, productionId]);

  const verbs = (type ? vocabulary.verbs[type] ?? [] : []).filter(v => !verbFilter || verbFilter(v));
  const subOptions = useMemo(() => {
    const set = new Set<string>(COMMON_SUBS);
    for (const s of (type ? vocabulary.subs[type] ?? [] : [])) set.add(s);
    return [...set].sort((a, b) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b)));
  }, [type, vocabulary]);

  const effId = (resId === CUSTOM ? customId.trim() : resId.trim()) || "*";
  const effSub = (sub === CUSTOM ? customSub.trim() : sub.trim()) || "*";
  const key = type && verb
    ? `node:${type}/${effId}${effSub !== "*" ? `/${effSub}` : ""}@${verb}`
    : null;

  const FIELD: React.CSSProperties = {
    padding: "7px 9px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8,
    background: "var(--paper)", color: "var(--ink)", maxWidth: 200,
  };

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <select value={type} onChange={e => setType(e.target.value)} style={{ ...FIELD, minWidth: 130 }}>
        <option value="">资源类型…</option>
        {types.map(t => <option key={t} value={t}>{typeLabel(t)}</option>)}
      </select>

      {type && (
        <>
          <select value={resId} onChange={e => setResId(e.target.value)} style={{ ...FIELD, minWidth: 120 }}>
            <option value="*">全部实例（*）</option>
            {directory.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            <option value={CUSTOM}>自定义 ID…</option>
          </select>
          {resId === CUSTOM && (
            <input value={customId} onChange={e => setCustomId(e.target.value)} placeholder="资源 ID" style={{ ...FIELD, width: 110 }} />
          )}

          <select value={sub} onChange={e => setSub(e.target.value)} style={{ ...FIELD, minWidth: 130 }}>
            {subOptions.map(s => <option key={s} value={s}>{subLabel(s)}</option>)}
            <option value={CUSTOM}>自定义面…</option>
          </select>
          {sub === CUSTOM && (
            <input value={customSub} onChange={e => setCustomSub(e.target.value)} placeholder="面（如 cues）" style={{ ...FIELD, width: 110 }} />
          )}

          <select value={verb} onChange={e => setVerb(e.target.value)} style={{ ...FIELD, minWidth: 100 }}>
            <option value="">动词…</option>
            {verbs.map(v => <option key={v} value={v}>{verbLabel(v)}</option>)}
          </select>
        </>
      )}

      <button
        style={{ ...PRIMARY_BTN, padding: "7px 12px" }}
        disabled={busy || !key}
        onClick={() => { if (key) onAdd(key); }}
      >
        添加
      </button>
      {key && (
        <code style={{ fontSize: 10, color: "var(--muted)", background: "var(--surface-2)", padding: "3px 7px", borderRadius: 6 }}>
          {key}
        </code>
      )}
    </div>
  );
}
