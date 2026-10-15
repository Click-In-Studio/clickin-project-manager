"use client";

import Link from "next/link";
import ProductionTopMenu, {
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS,
  ProductionToolbarBlock,
  ProductionTopMenuContext,
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
  return (
    <>
      <ProductionTopMenuContext label="构作" side="script" />
      <ProductionToolbarBlock id="workspace" priority={50}>
        <nav aria-label="构作工作区" className="flex shrink-0 items-center gap-0.5 rounded-[9px] bg-[var(--surface-2)] p-0.5">
          {SECTIONS.map((section) => (
            <Link key={section.id} href={`/production/${productionId}/${section.path}`}
              aria-current={active === section.id ? "page" : undefined}
              className={`inline-flex h-8 items-center whitespace-nowrap rounded-[7px] px-1 text-[11px] font-semibold ${active === section.id ? "border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-sm" : "border border-transparent text-[var(--muted)]"}`}>
              {section.label}
            </Link>
          ))}
        </nav>
      </ProductionToolbarBlock>
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
      <ProductionTopMenu progressive>
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
