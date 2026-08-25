"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

type NativeProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "multiple" | "size">;

type Props = NativeProps & {
  /** 超过该数量时显示搜索框。 */
  searchableAfter?: number;
  /** 浮层内容的安全高度上限；实际高度还会受视口剩余空间限制。 */
  menuMaxHeight?: number;
};

type Item = {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
};

const VIEWPORT_GUTTER = 10;
const MENU_GAP = 6;
const DEFAULT_MAX_HEIGHT = 320;

function textOf(node: ReactNode): string {
  return Children.toArray(node).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : "";
  }).join("");
}

function optionsFrom(children: ReactNode): Item[] {
  const items: Item[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === "option") {
      const option = child as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
      const label = textOf(option.props.children);
      items.push({ value: String(option.props.value ?? label), label, disabled: !!option.props.disabled });
      return;
    }
    if (child.type === "optgroup") {
      const group = child as ReactElement<{ label?: string; disabled?: boolean; children?: ReactNode }>;
      Children.forEach(group.props.children, (nested) => {
        if (!isValidElement(nested) || nested.type !== "option") return;
        const option = nested as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
        const label = textOf(option.props.children);
        items.push({
          value: String(option.props.value ?? label),
          label,
          disabled: !!group.props.disabled || !!option.props.disabled,
          group: group.props.label,
        });
      });
    }
  });
  return items;
}

export default function OverflowSafeSelect({
  children,
  value,
  defaultValue,
  onChange,
  onFocus,
  onBlur,
  disabled,
  className,
  style,
  searchableAfter = 8,
  menuMaxHeight = DEFAULT_MAX_HEIGHT,
  autoFocus,
  id,
  "aria-label": ariaLabel,
  ...nativeProps
}: Props) {
  const items = useMemo(() => optionsFrom(children), [children]);
  const generatedMenuId = useId();
  const menuId = `overflow-safe-select-${generatedMenuId.replace(/:/g, "")}`;
  const firstValue = items.find((item) => !item.disabled)?.value ?? "";
  const [uncontrolledValue, setUncontrolledValue] = useState(() => String(defaultValue ?? firstValue));
  const selectedValue = String(value ?? uncontrolledValue);
  const selected = items.find((item) => item.value === selectedValue) ?? items[0];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nativeRef = useRef<HTMLSelectElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) => `${item.group ?? ""} ${item.label}`.toLocaleLowerCase().includes(needle));
  }, [items, query]);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const availableBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_GUTTER;
    const availableAbove = rect.top - MENU_GAP - VIEWPORT_GUTTER;
    const openUp = availableBelow < Math.min(menuMaxHeight, 180) && availableAbove > availableBelow;
    const available = Math.max(96, openUp ? availableAbove : availableBelow);
    const width = Math.min(
      Math.max(rect.width, 220),
      window.innerWidth - VIEWPORT_GUTTER * 2,
    );
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER, rect.left),
      Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER),
    );
    setPosition({
      left,
      width,
      maxHeight: Math.min(menuMaxHeight, available),
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
    });
  }, [menuMaxHeight]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (autoFocus) triggerRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!open) return;
    place();
    const selectedIndex = filteredItems.findIndex((item) => item.value === selectedValue && !item.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : filteredItems.findIndex((item) => !item.disabled));
    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const reposition = () => place();
    document.addEventListener("pointerdown", pointerDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [close, filteredItems, open, place, selectedValue]);

  useEffect(() => {
    if (open && items.length > searchableAfter) searchRef.current?.focus();
  }, [items.length, open, searchableAfter]);

  function emitChange(nextValue: string) {
    if (value === undefined) setUncontrolledValue(nextValue);
    if (nativeRef.current) nativeRef.current.value = nextValue;
    const target = nativeRef.current ?? ({ value: nextValue } as HTMLSelectElement);
    onChange?.({ target, currentTarget: target } as ChangeEvent<HTMLSelectElement>);
    close(true);
  }

  function focusEvent(handler: typeof onFocus | typeof onBlur) {
    if (!handler) return;
    const target = nativeRef.current ?? ({ value: selectedValue } as HTMLSelectElement);
    handler({ target, currentTarget: target } as FocusEvent<HTMLSelectElement>);
  }

  function moveActive(direction: 1 | -1) {
    if (filteredItems.length === 0) return;
    let next = activeIndex;
    for (let i = 0; i < filteredItems.length; i++) {
      next = (next + direction + filteredItems.length) % filteredItems.length;
      if (!filteredItems[next]?.disabled) break;
    }
    setActiveIndex(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const typingInSearch = event.target instanceof HTMLInputElement;
    if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close(event.key === "Escape");
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" || (event.key === " " && !typingInSearch)) {
      event.preventDefault();
      const item = filteredItems[activeIndex];
      if (item && !item.disabled) emitChange(item.value);
    }
  }

  let lastGroup: string | undefined;

  return (
    <>
      <span style={{ position: "relative", display: "inline-flex", minWidth: 0, ...style }}>
        <select
          {...nativeProps}
          ref={nativeRef}
          id={id ? `${id}__native` : undefined}
          hidden
          tabIndex={-1}
          aria-hidden="true"
          value={selectedValue}
          onChange={() => {}}
          disabled={disabled}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        >
          {Children.map(children, (child) => isValidElement(child) ? cloneElement(child) : child)}
        </select>
        <button
          ref={triggerRef}
          id={id}
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={disabled}
          className={className}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={handleKeyDown}
          onFocus={() => focusEvent(onFocus)}
          onBlur={(event) => {
            if (menuRef.current?.contains(event.relatedTarget as Node)) return;
            focusEvent(onBlur);
          }}
          style={{
            width: "100%",
            minWidth: 0,
            minHeight: 34,
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "7px 10px",
            background: "var(--paper)",
            color: "var(--ink)",
            font: "inherit",
            textAlign: "left",
            cursor: disabled ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selected?.label ?? "请选择"}
          </span>
          <span aria-hidden="true" style={{ flexShrink: 0, color: "var(--muted)", fontSize: 10 }}>
            {open ? "▴" : "▾"}
          </span>
        </button>
      </span>

      {open && position && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: "fixed",
            zIndex: 180,
            left: position.left,
            width: position.width,
            top: position.top,
            bottom: position.bottom,
            maxHeight: position.maxHeight,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            border: "1px solid var(--line)",
            borderRadius: 10,
            background: "var(--surface)",
            boxShadow: "0 14px 36px rgba(24,42,42,.2)",
          }}
          onKeyDown={(event) => handleKeyDown(event as unknown as KeyboardEvent<HTMLButtonElement>)}
        >
          {items.length > searchableAfter && (
            <div style={{ padding: 8, borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索选项…"
                aria-label="搜索选项"
                style={{
                  width: "100%", border: "1px solid var(--line)", borderRadius: 8,
                  padding: "7px 9px", background: "var(--paper)", color: "var(--ink)",
                  fontSize: 12, outline: "none",
                }}
              />
            </div>
          )}
          <div style={{ minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: 4 }}>
            {filteredItems.map((item, index) => {
              const showGroup = !!item.group && item.group !== lastGroup;
              lastGroup = item.group;
              const selectedItem = item.value === selectedValue;
              return (
                <div key={`${item.group ?? ""}:${item.value}:${index}`}>
                  {showGroup && (
                    <div style={{ padding: "8px 10px 3px", color: "var(--muted)", fontSize: 9.5, fontWeight: 700, letterSpacing: ".05em" }}>
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedItem}
                    disabled={item.disabled}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => emitChange(item.value)}
                    style={{
                      display: "flex", width: "100%", alignItems: "center", gap: 8,
                      border: 0, borderRadius: 7, padding: "7px 10px", textAlign: "left",
                      background: selectedItem || activeIndex === index ? "var(--script-soft)" : "transparent",
                      color: "var(--ink)", cursor: item.disabled ? "not-allowed" : "pointer",
                      opacity: item.disabled ? .45 : 1, fontSize: 12,
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>{item.label}</span>
                    {selectedItem && <span aria-hidden="true" style={{ color: "var(--script)", fontWeight: 700 }}>✓</span>}
                  </button>
                </div>
              );
            })}
            {filteredItems.length === 0 && (
              <p style={{ margin: 0, padding: "18px 8px", textAlign: "center", color: "var(--muted)", fontSize: 11 }}>
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
