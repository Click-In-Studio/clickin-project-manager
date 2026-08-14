"use client";

import { useMemo, useState } from "react";
import { PRIMARY_BTN } from "@/components/PageHeader";

export type Vocabulary = {
  verbs: Record<string, string[]>;
  subs: Record<string, string[]>;
};

/**
 * 权限键选择器：type → (id) → sub → verb 级联，输出 node:type/id[/sub]@verb。
 * sub 提供在用面 datalist 提示但允许自由输入；id 默认 *（区间键）。
 */
export default function PermissionKeyPicker({
  vocabulary, onAdd, busy, verbFilter,
}: {
  vocabulary: Vocabulary;
  onAdd: (key: string) => void | Promise<void>;
  busy?: boolean;
  /** 限制可选动词（如 override 面板允许全动词，声明面板只允许 view/edit） */
  verbFilter?: (verb: string) => boolean;
}) {
  const types = useMemo(() => Object.keys(vocabulary.verbs).sort(), [vocabulary]);
  const [type, setType] = useState("");
  const [resId, setResId] = useState("*");
  const [sub, setSub] = useState("*");
  const [verb, setVerb] = useState("");

  const verbs = (type ? vocabulary.verbs[type] ?? [] : []).filter(v => !verbFilter || verbFilter(v));
  const subHints = type ? vocabulary.subs[type] ?? [] : [];
  const listId = `pkp-subs-${type}`;

  const key = type && verb
    ? `node:${type}/${(resId.trim() || "*")}${sub.trim() && sub.trim() !== "*" ? `/${sub.trim()}` : ""}@${verb}`
    : null;

  const FIELD: React.CSSProperties = {
    padding: "7px 9px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8,
    background: "var(--paper)", color: "var(--ink)",
  };

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <select value={type} onChange={e => { setType(e.target.value); setSub("*"); setVerb(""); }} style={{ ...FIELD, minWidth: 110 }}>
        <option value="">资源类型…</option>
        {types.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <input value={resId} onChange={e => setResId(e.target.value)} placeholder="id（* = 全部）" style={{ ...FIELD, width: 100 }} />
      <input
        value={sub} onChange={e => setSub(e.target.value)} placeholder="面（* = 主面）"
        list={listId} style={{ ...FIELD, width: 130 }}
      />
      <datalist id={listId}>
        {subHints.map(s => <option key={s} value={s} />)}
      </datalist>
      <select value={verb} onChange={e => setVerb(e.target.value)} style={{ ...FIELD, minWidth: 90 }}>
        <option value="">动词…</option>
        {verbs.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
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
