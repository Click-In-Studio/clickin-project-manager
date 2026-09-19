"use client";

import Link from "next/link";
import ProductionTopMenu, {
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS,
  PRODUCTION_TOOLBAR_STAGE,
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
  productionName,
  active,
}: {
  productionId: string;
  productionName: string;
  active: DramaturgyWorkspaceSection;
}) {
  const { stage } = useProductionToolbar();
  const compact = stage >= PRODUCTION_TOOLBAR_STAGE.primaryShort;
  const activeSection = SECTIONS.find((section) => section.id === active) ?? SECTIONS[0];

  return (
    <>
      <div className="flex shrink-0 items-center" style={{ lineHeight: 1.2 }}>
        {!compact && (
          <span className="mr-2 max-w-32 truncate whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--script)]">
            {productionName}
          </span>
        )}
        <span className="rounded-md bg-[var(--script-soft)] px-2 py-1 text-xs font-semibold text-[var(--script)]">构作</span>
      </div>
      <ProductionTopMenuDivider />
      {compact ? (
        <details className="group relative shrink-0">
          <summary className="flex h-8 cursor-pointer list-none items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2.5 text-[11px] font-semibold text-[var(--ink)] shadow-sm [&::-webkit-details-marker]:hidden">
            <span>{activeSection.label}</span>
            <span aria-hidden="true" className="text-[10px] text-[var(--muted)] transition-transform group-open:rotate-180">⌄</span>
          </summary>
          <nav aria-label="构作工作区" className="absolute left-0 top-full z-50 mt-2 w-32 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md">
            {SECTIONS.map((section) => (
              <Link
                key={section.id}
                href={`/production/${productionId}/${section.path}`}
                aria-current={active === section.id ? "page" : undefined}
                className={`block px-3 py-2 text-xs ${active === section.id ? "bg-[var(--surface-2)] font-semibold text-[var(--ink)]" : "text-[var(--muted)] hover:bg-[var(--surface-2)]"}`}
              >
                {section.label}
              </Link>
            ))}
          </nav>
        </details>
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
  productionName,
  children,
}: {
  productionId: string;
  productionName: string;
  children: React.ReactNode;
}) {
  return (
    <div className={PRODUCTION_PAGE_SCROLL_ROOT_CLASS}>
      <ProductionTopMenu>
        <DramaturgyWorkspaceHeading
          productionId={productionId}
          productionName={productionName}
          active="inspiration"
        />
      </ProductionTopMenu>
      <div className="flex-1 overflow-y-auto px-[clamp(18px,3vw,52px)] pb-[60px] pt-6">
        {children}
      </div>
    </div>
  );
}
