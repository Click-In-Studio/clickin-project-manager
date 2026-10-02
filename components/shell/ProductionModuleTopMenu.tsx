"use client";

import type { ReactNode } from "react";
import ProductionTopMenu, {
  PRODUCTION_TOP_MENU_RIGHT_CLASS,
  PRODUCTION_TOOLBAR_STAGE,
  ProductionTopMenuContext,
  ProductionTopMenuDivider,
  type ProductionTopMenuSide,
  useProductionToolbar,
} from "./ProductionTopMenu";

export const PRODUCTION_MODULE_ACTION_CLASS =
  "inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-[var(--ink)] bg-[var(--ink)] px-3 text-xs font-bold text-white transition-colors hover:opacity-90";

export const PRODUCTION_MODULE_SECONDARY_ACTION_CLASS =
  "inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--ink)] transition-colors hover:border-[var(--stage)] hover:bg-[var(--paper)]";

export const PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS =
  "flex w-full items-center px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50";

/**
 * 制作侧与项目总览共用的顶部工具栏壳。
 *
 * 收缩顺序直接复用剧本 / Cue 已有阶段：搜索先收起，次要操作进入「更多」，
 * 主操作缩成短标签，最后也进入「更多」。调用方只提供同一动作在三种落点的
 * 表达，不再各页另写媒体查询或宽度判断。
 */
export default function ProductionModuleTopMenu({
  label,
  side = "stage",
  primaryAction,
  primaryShortAction,
  primaryOverflowAction,
  secondaryActions,
  secondaryOverflowActions,
}: {
  label: string;
  side?: Extract<ProductionTopMenuSide, "overview" | "stage">;
  primaryAction?: ReactNode;
  primaryShortAction?: ReactNode;
  primaryOverflowAction?: ReactNode;
  secondaryActions?: ReactNode;
  secondaryOverflowActions?: ReactNode;
}) {
  const { stage, closeOverflow } = useProductionToolbar();
  const secondaryStored = stage >= PRODUCTION_TOOLBAR_STAGE.secondaryStored;
  const primaryShort = stage >= PRODUCTION_TOOLBAR_STAGE.primaryShort;
  const primaryStored = stage >= PRODUCTION_TOOLBAR_STAGE.primaryStored;
  const overflow = (secondaryStored && secondaryActions) || (primaryStored && primaryAction)
    ? (
      <div data-production-module-overflow-actions="true" onClick={closeOverflow}>
        {primaryStored && (primaryOverflowAction ?? primaryAction)}
        {secondaryStored && (secondaryOverflowActions ?? secondaryActions)}
      </div>
    )
    : null;

  const visiblePrimary = primaryStored
    ? null
    : primaryShort
      ? (primaryShortAction ?? primaryAction)
      : primaryAction;
  const visibleSecondary = secondaryStored ? null : secondaryActions;

  return (
    <ProductionTopMenu overflow={overflow}>
      <ProductionTopMenuContext label={label} side={side} />
      {(visiblePrimary || visibleSecondary) && <ProductionTopMenuDivider />}
      {(visiblePrimary || visibleSecondary) && (
        <div
          data-production-module-top-actions="true"
          className={`${PRODUCTION_TOP_MENU_RIGHT_CLASS} ml-auto flex shrink-0 items-center gap-2`}
        >
          {visibleSecondary}
          {visiblePrimary}
        </div>
      )}
    </ProductionTopMenu>
  );
}
