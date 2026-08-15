"use client";

/**
 * 下拉式 picker（模态 picker 的轻量替代）：触发字段原位展开、搜索过滤、
 * 树形缩进（parentId）+ 分组 header 行、单选/多选。
 * 弹层经 portal 挂到 body（fixed 定位 + 空间不足向上翻转 + 滚动跟随），
 * 不受模态/容器 overflow 裁剪。大列表友好（限高内滚 + 搜索）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type DropdownPickerItem = {
  /** 行唯一 key（树形分组下同一实体可多行出现，用带前缀的合成 id） */
  id: string;
  /** 语义值（选中/回调用；缺省 = id）。header 行忽略 */
  value?: string;
  label: string;
  /** 次行（如角色、日期、提示） */
  sublabel?: string;
  /** 有 parentId 树状缩进；平铺列表则全为 null/undefined */
  parentId?: string | null;
  /** 分组表头行：不可选，uppercase muted 样式 */
  header?: boolean;
  disabled?: boolean;
};

type Props = {
  items: DropdownPickerItem[];
  /** 单选当前值（多选用 values）；对应 item.value */
  value?: string | null;
  values?: Set<string>;
  multi?: boolean;
  placeholder: string;
  /** 单选可清除：显示为列表首项（如"不绑定部门"） */
  clearLabel?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** 多选触发按钮文案（缺省"已选 N 人"） */
  multiCountLabel?: (n: number) => string;
  /** 单选：选中即回调并收起；清除回调 null。多选：切换项逐个回调 onToggle */
  onChange: (id: string | null) => void;
  onToggle?: (id: string) => void;
};

const FIELD: React.CSSProperties = {
  width: "100%", border: "1px solid var(--line)", borderRadius: 8,
  padding: "9px 12px", fontSize: 12, color: "var(--ink)",
  background: "var(--paper)", outline: "none", textAlign: "left", cursor: "pointer",
};

const POP_MAX_H = 300;

export default function DropdownPicker({
  items, value, values, multi, placeholder, clearLabel, searchPlaceholder, disabled,
  multiCountLabel, onChange, onToggle,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < POP_MAX_H + 60 && r.top > spaceBelow;
    setPos({
      top: up ? r.top - 4 : r.bottom + 4,
      left: r.left,
      width: r.width,
      up,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const close = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // capture 相：模态内部滚动也能跟随重定位
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  // 树序展开（无 parentId 退化平铺）；搜索命中项保留祖先维持树形
  const tree = useMemo(() => {
    const ids = new Set(items.map(i => i.id));
    const byParent = new Map<string | null, DropdownPickerItem[]>();
    for (const it of items) {
      const key = it.parentId && ids.has(it.parentId) ? it.parentId : null;
      byParent.set(key, [...(byParent.get(key) ?? []), it]);
    }
    const out: { item: DropdownPickerItem; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const it of byParent.get(parent) ?? []) { out.push({ item: it, depth }); walk(it.id, depth + 1); }
    };
    walk(null, 0);
    return out;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set(items.map(i => i.id));
    const hit = new Set(
      items
        .filter(i => !i.header)
        .filter(i => i.label.toLowerCase().includes(q) || (i.sublabel ?? "").toLowerCase().includes(q))
        .map(i => i.id),
    );
    // header 命中 ⇒ 整组子孙可见
    const byId = new Map(items.map(i => [i.id, i]));
    const headerHit = new Set(items.filter(i => i.header && i.label.toLowerCase().includes(q)).map(i => i.id));
    if (headerHit.size > 0) {
      for (const it of items) {
        let cur: string | null | undefined = it.parentId;
        while (cur) {
          if (headerHit.has(cur)) { hit.add(it.id); break; }
          cur = byId.get(cur)?.parentId;
        }
      }
      for (const id of headerHit) hit.add(id);
    }
    // 命中项的祖先保留（维持树形）
    for (const id of [...hit]) {
      let cur = byId.get(id)?.parentId;
      while (cur && byId.has(cur) && !hit.has(cur)) { hit.add(cur); cur = byId.get(cur)?.parentId; }
    }
    return hit;
  }, [items, query]);

  const valueOf = (it: DropdownPickerItem) => it.value ?? it.id;
  const selectedLabel = !multi && value
    ? items.find(i => !i.header && valueOf(i) === value)?.label ?? null
    : null;
  const selectedCount = multi ? (values?.size ?? 0) : 0;

  function rowClick(it: DropdownPickerItem) {
    if (it.disabled || it.header) return;
    if (multi) { onToggle?.(valueOf(it)); }
    else { onChange(valueOf(it)); setOpen(false); setQuery(""); }
  }

  const visibleRows = tree.filter(({ item }) => visible.has(item.id));
  const hasOptions = visibleRows.some(({ item }) => !item.header);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        style={{
          ...FIELD,
          fontWeight: selectedLabel || selectedCount ? 700 : 400,
          color: selectedLabel || selectedCount ? "var(--ink)" : "var(--muted)",
          opacity: disabled ? 0.5 : 1,
          display: "flex", alignItems: "center", gap: 8,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedLabel
            ?? (selectedCount > 0 ? (multiCountLabel?.(selectedCount) ?? `已选 ${selectedCount} 人`) : placeholder)}
        </span>
        <span style={{ fontSize: 9, color: "var(--muted)", flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={popRef}
          style={{
            position: "fixed", zIndex: 120,
            left: pos.left, width: Math.max(pos.width, 240),
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10,
            boxShadow: "0 12px 32px rgba(24,42,42,.2)", overflow: "hidden",
            display: "flex", flexDirection: "column",
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={searchPlaceholder ?? "搜索…"}
              style={{ ...FIELD, cursor: "text", padding: "7px 10px" }}
            />
          </div>
          <div style={{ maxHeight: POP_MAX_H - 50, overflowY: "auto", padding: 4 }}>
            {!multi && clearLabel && (
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false); setQuery(""); }}
                style={{
                  display: "block", width: "100%", textAlign: "left", border: 0, cursor: "pointer",
                  borderRadius: 7, padding: "7px 10px", fontSize: 12,
                  background: !value ? "var(--script-soft)" : "transparent",
                  color: "var(--muted)",
                }}
              >
                {clearLabel}
              </button>
            )}
            {visibleRows.map(({ item, depth }) => {
              if (item.header) {
                return (
                  <p
                    key={item.id}
                    style={{
                      margin: 0, padding: "6px 10px 3px", paddingLeft: 10 + depth * 14,
                      fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em",
                      textTransform: "uppercase", color: "var(--muted)",
                    }}
                  >
                    {item.label}
                  </p>
                );
              }
              const on = multi ? (values?.has(valueOf(item)) ?? false) : value === valueOf(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => rowClick(item)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    border: 0, cursor: item.disabled ? "not-allowed" : "pointer",
                    borderRadius: 7, padding: "6px 10px", paddingLeft: 10 + depth * 14,
                    background: on ? "var(--script-soft)" : "transparent",
                    opacity: item.disabled ? 0.45 : 1,
                  }}
                >
                  {multi && (
                    <span style={{
                      width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                      border: "1.5px solid " + (on ? "var(--script)" : "var(--line)"),
                      background: on ? "var(--script)" : "var(--paper)",
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      color: "#fff", fontSize: 9, lineHeight: 1,
                    }}>
                      {on ? "✓" : ""}
                    </span>
                  )}
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.label}
                    </span>
                    {item.sublabel && (
                      <span style={{ display: "block", marginTop: 1, fontSize: 9.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.sublabel}
                      </span>
                    )}
                  </span>
                  {!multi && on && <span style={{ fontSize: 11, color: "var(--script)", flexShrink: 0 }}>✓</span>}
                </button>
              );
            })}
            {!hasOptions && (
              <p style={{ margin: 0, padding: "16px 0", textAlign: "center", fontSize: 11, color: "var(--muted)" }}>
                无匹配项
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
