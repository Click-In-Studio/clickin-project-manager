"use client";

import { useMemo, useState } from "react";
import AdminModal from "@/components/AdminModal";
import Badge from "@/components/Badge";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";

export type TreePickerItem = {
  id: string;
  label: string;
  /** 有 parentId 树状缩进展示；平铺列表则全为 null */
  parentId?: string | null;
  badge?: string;
  /** 展示但不可改（如系统角色）——确认结果中保持原选中状态 */
  disabled?: boolean;
};

type Props = {
  kicker?: string;
  title: string;
  items: TreePickerItem[];
  /** 预选集合（当前持有）；确认返回新的完整选中集合 */
  preselected: string[];
  confirmLabel?: string;
  busy?: boolean;
  /** 单选模式：点击即确认（无 checkbox 与底部确认按钮） */
  single?: boolean;
  onConfirm: (selectedIds: string[]) => void | Promise<void>;
  onClose: () => void;
};

export default function TreePickerModal({
  kicker, title, items, preselected, confirmLabel = "保存", busy, single, onConfirm, onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(preselected));

  // 树序展开（无 parentId 字段时退化为平铺）
  const tree = useMemo(() => {
    const ids = new Set(items.map(i => i.id));
    const byParent = new Map<string | null, TreePickerItem[]>();
    for (const it of items) {
      const key = it.parentId && ids.has(it.parentId) ? it.parentId : null;
      byParent.set(key, [...(byParent.get(key) ?? []), it]);
    }
    const out: { item: TreePickerItem; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const it of byParent.get(parent) ?? []) { out.push({ item: it, depth }); walk(it.id, depth + 1); }
    };
    walk(null, 0);
    return out;
  }, [items]);

  // 名字搜索：命中项可见；树中命中项的祖先保留（保持树形）
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set(items.map(i => i.id));
    const hit = new Set(items.filter(i => i.label.toLowerCase().includes(q)).map(i => i.id));
    const byId = new Map(items.map(i => [i.id, i]));
    for (const id of [...hit]) {
      let cur = byId.get(id)?.parentId ?? null;
      while (cur && byId.has(cur) && !hit.has(cur)) { hit.add(cur); cur = byId.get(cur)?.parentId ?? null; }
    }
    return hit;
  }, [items, query]);

  function toggle(item: TreePickerItem) {
    if (item.disabled) return;
    setPicked(prev => {
      const s = new Set(prev);
      if (s.has(item.id)) s.delete(item.id); else s.add(item.id);
      return s;
    });
  }

  return (
    <AdminModal kicker={kicker} title={title} onClose={onClose} width={440}>
      <input
        value={query} onChange={e => setQuery(e.target.value)} autoFocus
        placeholder="搜索名称"
        style={{
          width: "100%", padding: "8px 10px", marginBottom: 10, fontSize: 12,
          border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)",
        }}
      />
      <div style={{ maxHeight: "46vh", overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10, padding: 8, background: "var(--surface)" }}>
        {tree.filter(({ item }) => visible.has(item.id)).map(({ item, depth }) => {
          const on = picked.has(item.id);
          return (
            <button
              key={item.id}
              disabled={busy || item.disabled}
              onClick={() => (single ? !item.disabled && onConfirm([item.id]) : toggle(item))}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "6px 8px", paddingLeft: 8 + depth * 16, borderRadius: 8,
                border: "none", cursor: item.disabled ? "not-allowed" : "pointer", textAlign: "left",
                background: on ? "var(--script-soft)" : "transparent",
                opacity: item.disabled ? 0.55 : 1,
              }}
            >
              {!single && (
                <span style={{
                  width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                  border: "1.5px solid " + (on ? "var(--script)" : "var(--line)"),
                  background: on ? "var(--script)" : "var(--paper)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontSize: 10, lineHeight: 1,
                }}>
                  {on ? "✓" : ""}
                </span>
              )}
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.label}
              </span>
              {item.badge && <Badge tone="amber">{item.badge}</Badge>}
            </button>
          );
        })}
        {tree.every(({ item }) => !visible.has(item.id)) && (
          <p style={{ margin: 0, padding: "22px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
            无匹配项
          </p>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
        <span style={{ flex: 1, fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>
          {single ? "点击即选定" : `已选 ${picked.size} 项`}
        </span>
        <button style={SECONDARY_BTN} onClick={onClose}>取消</button>
        {!single && (
          <button style={PRIMARY_BTN} disabled={busy} onClick={() => onConfirm([...picked])}>
            {confirmLabel}
          </button>
        )}
      </div>
    </AdminModal>
  );
}
