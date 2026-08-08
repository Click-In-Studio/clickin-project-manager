"use client";

import {
  type CSSProperties,
  createContext,
  type MouseEventHandler,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const PRODUCTION_TOP_MENU_SLOT_ID = "production-page-toolbar-slot";
export const PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID = "production-page-toolbar-overflow-slot";
export const PRODUCTION_TOP_MENU_SEARCH_OVERFLOW_SLOT_ID = "production-page-toolbar-search-overflow-slot";
export const PRODUCTION_TOP_MENU_RIGHT_CLASS = "production-top-menu-right";

export type ProductionToolbarStage = 0 | 1 | 2 | 3 | 4.1 | 4.2 | 5 | 6 | 7;

export const ProductionToolbarContext = createContext<{
  stage: ProductionToolbarStage;
  closeOverflow: () => void;
  overflowOpen: boolean;
  hasStoredControls: boolean;
  setHasStoredControls: (hasStoredControls: boolean) => void;
}>({ stage: 0, closeOverflow: () => {}, overflowOpen: false, hasStoredControls: false, setHasStoredControls: () => {} });

export function useProductionToolbar() {
  return useContext(ProductionToolbarContext);
}

const HIDDEN_ANCHORED_MENU_STYLE: CSSProperties = { position: "fixed", visibility: "hidden" };

export function useAnchoredMenu<T extends HTMLElement>(open: boolean, placement: "bottom" | "left", positionKey?: string | null) {
  const anchorRef = useRef<T | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    key: string | null | undefined;
    style: CSSProperties;
  }>({ key: positionKey, style: HIDDEN_ANCHORED_MENU_STYLE });

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const padding = 8;
    const gap = placement === "bottom" ? 10 : 6;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const maxWidth = Math.max(0, window.innerWidth - padding * 2);
    const viewportMaxHeight = Math.max(0, window.innerHeight - padding * 2);
    const menuWidth = Math.min(menuRect.width, maxWidth);
    const menuHeight = Math.min(menuRect.height, viewportMaxHeight);
    let maxHeight = viewportMaxHeight;
    let left: number;
    let top: number;

    if (placement === "left") {
      const primaryRect = anchor.closest<HTMLElement>("[data-production-overflow-menu]")?.getBoundingClientRect() ?? anchorRect;
      const spaceLeft = primaryRect.left - gap - padding;
      const spaceRight = window.innerWidth - primaryRect.right - gap - padding;
      if (spaceLeft >= menuWidth) {
        left = primaryRect.left - menuWidth - gap;
        top = anchorRect.top;
      } else if (spaceRight >= menuWidth) {
        left = primaryRect.right + gap;
        top = anchorRect.top;
      } else {
        left = anchorRect.left;
        if (left + menuWidth > window.innerWidth - padding) left = anchorRect.right - menuWidth;
        const spaceBelow = window.innerHeight - primaryRect.bottom - gap - padding;
        const spaceAbove = primaryRect.top - gap - padding;
        if (spaceBelow >= spaceAbove) {
          top = primaryRect.bottom + gap;
          maxHeight = Math.max(0, spaceBelow);
        } else {
          maxHeight = Math.max(0, spaceAbove);
          top = primaryRect.top - gap - Math.min(menuHeight, maxHeight);
        }
      }
    } else {
      left = anchorRect.left;
      if (left + menuWidth > window.innerWidth - padding) left = anchorRect.right - menuWidth;
      top = anchorRect.bottom + gap;
      if (top + menuHeight > window.innerHeight - padding && anchorRect.top - menuHeight - gap >= padding) {
        top = anchorRect.top - menuHeight - gap;
      }
    }

    const renderedMenuHeight = Math.min(menuHeight, maxHeight);
    left = Math.min(Math.max(padding, left), Math.max(padding, window.innerWidth - menuWidth - padding));
    top = Math.min(Math.max(padding, top), Math.max(padding, window.innerHeight - renderedMenuHeight - padding));
    const style: CSSProperties = {
      position: "fixed",
      left,
      top,
      maxWidth,
      maxHeight,
      overflowY: menuRect.height > maxHeight ? "auto" : undefined,
      visibility: "visible",
    };
    setPosition((current) => current.key === positionKey
      && current.style.left === style.left
      && current.style.top === style.top
      && current.style.maxWidth === style.maxWidth
      && current.style.maxHeight === style.maxHeight
      && current.style.overflowY === style.overflowY
      && current.style.visibility === style.visibility
      ? current
      : { key: positionKey, style });
  }, [placement, positionKey]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition((current) => current.key === positionKey && current.style === HIDDEN_ANCHORED_MENU_STYLE
        ? current
        : { key: positionKey, style: HIDDEN_ANCHORED_MENU_STYLE });
      return;
    }
    update();
    let frame: number | null = null;
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };
    const observer = new ResizeObserver(scheduleUpdate);
    if (anchorRef.current) observer.observe(anchorRef.current);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [open, positionKey, update]);

  const style = position.key === positionKey ? position.style : HIDDEN_ANCHORED_MENU_STYLE;
  return { anchorRef, menuRef, style };
}

export function ProductionOverflowSubmenuButton({
  menuId,
  label,
  detail,
  expanded,
  onToggle,
}: {
  menuId: string;
  label: ReactNode;
  detail?: ReactNode;
  expanded: boolean;
  onToggle: (anchor: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      data-production-overflow-submenu-trigger={menuId}
      aria-expanded={expanded}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => onToggle(event.currentTarget)}
      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="ml-2 shrink-0">{detail}</span>}
      <svg className="ml-2 h-3 w-3 shrink-0 opacity-50" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function ProductionTopMenuDivider() {
  return (
    <div
      aria-hidden="true"
      className="mx-3 h-7 w-px shrink-0 bg-[var(--line)]"
    />
  );
}

type Props = {
  children: ReactNode | ((portaled: boolean) => ReactNode);
  overflow?: ReactNode;
  barRef?: Ref<HTMLDivElement>;
  fallbackClassName?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
};

export default function ProductionTopMenu({
  children,
  overflow,
  barRef,
  fallbackClassName = "gap-0 px-4",
  onClick,
}: Props) {
  const { setHasStoredControls } = useProductionToolbar();
  const hasOverflow = overflow !== null && overflow !== undefined;
  const [targets, setTargets] = useState<{
    bar: HTMLElement | null;
    overflow: HTMLElement | null;
  }>();

  useLayoutEffect(() => {
    const bar = document.getElementById(PRODUCTION_TOP_MENU_SLOT_ID);
    const overflowTarget = document.getElementById(PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID);
    setTargets({ bar, overflow: overflowTarget });
    if (!bar) return;
    bar.setAttribute("data-toolbar-ready", "true");
    return () => bar.removeAttribute("data-toolbar-ready");
  }, []);

  useLayoutEffect(() => {
    setHasStoredControls(hasOverflow);
    return () => setHasStoredControls(false);
  }, [hasOverflow, setHasStoredControls]);

  if (targets === undefined) return null;

  const target = targets.bar;
  const portaled = target !== null;
  const content = (
    <div
      ref={barRef}
      onClick={onClick}
      data-production-top-menu-root="true"
      className={`relative flex flex-nowrap items-center ${
        portaled
          ? "h-full w-full min-w-0 gap-0 px-0"
          : `h-14 shrink-0 border-b border-[var(--line)] bg-[var(--surface)] shadow-sm ${fallbackClassName}`
      }`}
    >
      {typeof children === "function" ? children(portaled) : children}
      {!targets.overflow && overflow}
    </div>
  );

  return (
    <>
      {target ? createPortal(content, target) : content}
      {targets.overflow && overflow ? createPortal(overflow, targets.overflow) : null}
    </>
  );
}
