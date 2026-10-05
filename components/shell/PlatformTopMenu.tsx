"use client";

import type { ReactNode } from "react";
import ProductionTopMenu, {
  PRODUCTION_TOOLBAR_STAGE,
  useProductionToolbar,
} from "./ProductionTopMenu";

export function PlatformTopMenuTitle({ title, eyebrow = "平台级", placeholder = false }: {
  title: string;
  eyebrow?: string;
  placeholder?: boolean;
}) {
  const Title = placeholder ? "span" : "h1";
  return (
    <div data-production-top-menu-placeholder={placeholder ? "true" : undefined}
      className="flex shrink-0 flex-col gap-0.5">
      <p className="m-0 whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{eyebrow}</p>
      <Title className="m-0 whitespace-nowrap font-serif text-sm font-medium leading-tight text-[var(--ink)]">{title}</Title>
    </div>
  );
}

/** 平台页面复用现有顶栏插槽与溢出菜单，加载态和动态页名使用同一个入口。 */
export default function PlatformTopMenu({ title, eyebrow, actions }: {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  const { stage, closeOverflow } = useProductionToolbar();
  const stored = stage >= PRODUCTION_TOOLBAR_STAGE.secondaryStored;
  return (
    <ProductionTopMenu overflow={actions && stored ? (
      <div onClick={closeOverflow} className="flex flex-col gap-1 p-1 [&>button]:w-full [&>button]:justify-start">{actions}</div>
    ) : null}>
      <PlatformTopMenuTitle title={title} eyebrow={eyebrow} />
      {actions && !stored && <div className="ml-auto flex shrink-0 items-center gap-2 pl-3">{actions}</div>}
    </ProductionTopMenu>
  );
}
