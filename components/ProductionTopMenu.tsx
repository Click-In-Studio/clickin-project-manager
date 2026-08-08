"use client";

import {
  type MouseEventHandler,
  type ReactNode,
  type Ref,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const PRODUCTION_TOP_MENU_SLOT_ID = "production-page-toolbar-slot";
export const PRODUCTION_TOP_MENU_RIGHT_CLASS = "production-top-menu-right";

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
  barRef?: Ref<HTMLDivElement>;
  fallbackClassName?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
};

export default function ProductionTopMenu({
  children,
  barRef,
  fallbackClassName = "gap-0 px-4",
  onClick,
}: Props) {
  const [target, setTarget] = useState<HTMLElement | null | undefined>(undefined);

  useLayoutEffect(() => {
    const nextTarget = document.getElementById(PRODUCTION_TOP_MENU_SLOT_ID);
    setTarget(nextTarget);
    if (!nextTarget) return;
    nextTarget.setAttribute("data-toolbar-ready", "true");
    return () => nextTarget.removeAttribute("data-toolbar-ready");
  }, []);

  if (target === undefined) return null;

  const portaled = target !== null;
  const content = (
    <div
      ref={barRef}
      onClick={onClick}
      className={`relative flex flex-nowrap items-center ${
        portaled
          ? "h-full w-full min-w-0 gap-0 px-0"
          : `h-14 shrink-0 border-b border-[var(--line)] bg-[var(--surface)] shadow-sm ${fallbackClassName}`
      }`}
    >
      {typeof children === "function" ? children(portaled) : children}
    </div>
  );

  return target ? createPortal(content, target) : content;
}
