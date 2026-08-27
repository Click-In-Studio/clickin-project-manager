"use client";

import Link from "next/link";
import ProductionTopMenu, {
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS,
  ProductionTopMenuDivider,
} from "./ProductionTopMenu";

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
  return (
    <>
      <div className="flex shrink-0 flex-col" style={{ lineHeight: 1.2 }}>
        <span className="max-w-40 truncate whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--script)]">
          {productionName}
        </span>
        <span className="text-xs font-semibold text-[var(--ink)]">构作</span>
      </div>
      <ProductionTopMenuDivider />
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
