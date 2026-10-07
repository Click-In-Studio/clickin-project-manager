"use client";

import type { ReactNode } from "react";
import ProductionTopMenu, {
  PRODUCTION_TOOLBAR_STAGE,
  useProductionToolbar,
} from "./ProductionTopMenu";

export function PlatformTopMenuTitle({ title, placeholder = false }: {
  title: string;
  placeholder?: boolean;
}) {
  const Title = placeholder ? "span" : "h1";
  return (
    <div data-production-top-menu-placeholder={placeholder ? "true" : undefined}
      className="flex shrink-0 items-center">
      <Title className="m-0 whitespace-nowrap font-serif text-sm font-medium leading-tight text-[var(--ink)]">{title}</Title>
    </div>
  );
}

/** 平台页面复用现有顶栏插槽与溢出菜单，加载态和动态页名使用同一个入口。 */
export default function PlatformTopMenu({ title, actions }: {
  title: string;
  actions?: ReactNode;
}) {
  const { stage, closeOverflow } = useProductionToolbar();
  const stored = stage >= PRODUCTION_TOOLBAR_STAGE.secondaryStored;
  return (
    <ProductionTopMenu overflow={actions && stored ? (
      <div onClick={closeOverflow} className="flex flex-col gap-1 p-1 [&>button]:w-full [&>button]:justify-start">{actions}</div>
    ) : null}>
      <PlatformTopMenuTitle title={title} />
      {actions && !stored && <div className="ml-auto flex shrink-0 items-center gap-2 pl-3">{actions}</div>}
    </ProductionTopMenu>
  );
}
