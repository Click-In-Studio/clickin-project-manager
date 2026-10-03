"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ChevronIcon from "@/components/ui/ChevronIcon";
import ProductionTopMenu, {
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS,
  PRODUCTION_TOOLBAR_STAGE,
  ProductionTopMenuContext,
  ProductionTopMenuDivider,
  useProductionToolbar,
} from "../shell/ProductionTopMenu";

export type DramaturgyWorkspaceSection = "overview" | "characters" | "inspiration";

const SECTIONS: readonly {
  id: DramaturgyWorkspaceSection;
  label: string;
  path: string;
}[] = [
  { id: "overview", label: "构作视图", path: "dramaturgy" },
  { id: "characters", label: "角色", path: "characters" },
  { id: "inspiration", label: "灵感文档", path: "dramaturgy/inspiration" },
];

export function DramaturgyWorkspaceHeading({
  productionId,
  active,
}: {
  productionId: string;
  active: DramaturgyWorkspaceSection;
}) {
  const { stage } = useProductionToolbar();
  const compact = stage >= PRODUCTION_TOOLBAR_STAGE.primaryShort;
  const activeSection = SECTIONS.find((section) => section.id === active) ?? SECTIONS[0];
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || workspaceMenuRef.current?.contains(target)) return;
      setWorkspaceMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [workspaceMenuOpen]);

  return (
    <>
      <ProductionTopMenuContext label="构作" side="script" />
      <ProductionTopMenuDivider />
      {compact ? (
        <div ref={workspaceMenuRef} className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={workspaceMenuOpen}
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
            className="flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2.5 text-[11px] font-semibold text-[var(--ink)] shadow-sm"
          >
            <span>{activeSection.label}</span>
            <ChevronIcon
              direction={workspaceMenuOpen ? "up" : "down"}
              size={12}
              className="shrink-0 self-center text-[var(--muted)]"
            />
          </button>
          {workspaceMenuOpen && (
            <nav aria-label="构作工作区" className="absolute left-0 top-full z-50 mt-2 w-32 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md">
              {SECTIONS.map((section) => (
                <Link
                  key={section.id}
                  href={`/production/${productionId}/${section.path}`}
                  aria-current={active === section.id ? "page" : undefined}
                  onClick={() => setWorkspaceMenuOpen(false)}
                  className={`block px-3 py-2 text-xs ${active === section.id ? "bg-[var(--surface-2)] font-semibold text-[var(--ink)]" : "text-[var(--muted)] hover:bg-[var(--surface-2)]"}`}
                >
                  {section.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
      ) : (
        <nav
          aria-label="构作工作区"
          className="flex shrink-0 items-center gap-0.5 rounded-[9px] bg-[var(--surface-2)] p-0.5"
        >
          {SECTIONS.map((section) => (
            <Link
              key={section.id}
              href={`/production/${productionId}/${section.path}`}
              aria-current={active === section.id ? "page" : undefined}
              className={`inline-flex h-7 items-center whitespace-nowrap rounded-[7px] px-2.5 text-[11px] font-semibold transition-colors ${
                active === section.id
                  ? "border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-sm"
                  : "border border-transparent text-[var(--muted)] hover:bg-[var(--surface)]/70 hover:text-[var(--ink)]"
              }`}
            >
              {section.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}

export function DramaturgyInspirationShell({
  productionId,
  children,
}: {
  productionId: string;
  children: React.ReactNode;
}) {
  return (
    <div className={PRODUCTION_PAGE_SCROLL_ROOT_CLASS}>
      <ProductionTopMenu>
        <DramaturgyWorkspaceHeading
          productionId={productionId}
          active="inspiration"
        />
      </ProductionTopMenu>
      <div className="flex-1 overflow-y-auto px-[clamp(18px,3vw,52px)] pb-[60px] pt-6">
        {children}
      </div>
    </div>
  );
}
