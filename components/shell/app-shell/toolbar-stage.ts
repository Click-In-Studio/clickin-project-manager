import {
  PRODUCTION_TOP_MENU_SLOT_ID,
  PRODUCTION_TOOLBAR_STAGE,
  type ProductionToolbarStage,
} from "../ProductionTopMenu";

const PRODUCTION_TOOLBAR_STAGES: readonly ProductionToolbarStage[] = [
  PRODUCTION_TOOLBAR_STAGE.full,
  PRODUCTION_TOOLBAR_STAGE.searchCollapsed,
  PRODUCTION_TOOLBAR_STAGE.secondaryStored,
  PRODUCTION_TOOLBAR_STAGE.primaryShort,
  PRODUCTION_TOOLBAR_STAGE.primaryStored,
  PRODUCTION_TOOLBAR_STAGE.lowPriorityStored,
];

export const PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX = 6;

export type ProductionHeaderStage = 0 | 1 | 2;

export function productionHeaderStageForWidth(width: number): ProductionHeaderStage {
  if (width >= 1280) return 0;
  if (width >= 1024) return 1;
  return 2;
}

export function adjacentProductionToolbarStage(
  stage: ProductionToolbarStage,
  direction: -1 | 1,
): ProductionToolbarStage {
  const index = PRODUCTION_TOOLBAR_STAGES.indexOf(stage);
  return PRODUCTION_TOOLBAR_STAGES[index + direction] ?? stage;
}

function horizontalMargins(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  return (Number.parseFloat(style.marginLeft) || 0) + (Number.parseFloat(style.marginRight) || 0);
}

function outerWidth(element: HTMLElement): number {
  return element.getBoundingClientRect().width + horizontalMargins(element);
}

function productionToolbarContentWidth(slot: HTMLElement): number {
  const root = slot.querySelector<HTMLElement>("[data-production-top-menu-root]");
  if (!root) return outerWidth(slot);

  const rootStyle = window.getComputedStyle(root);
  const gap = Number.parseFloat(rootStyle.columnGap) || 0;
  const padding = (Number.parseFloat(rootStyle.paddingLeft) || 0)
    + (Number.parseFloat(rootStyle.paddingRight) || 0);
  let width = padding;
  let visibleCount = 0;

  for (const child of root.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = window.getComputedStyle(child);
    if (style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;

    const isFlexible = Number.parseFloat(style.flexGrow) > 0;
    const flexContent = isFlexible
      ? child.querySelector<HTMLElement>("[data-production-toolbar-flex-content]")
      : null;

    width += flexContent ? outerWidth(flexContent) : isFlexible ? horizontalMargins(child) : outerWidth(child);
    visibleCount += 1;
  }

  return width + Math.max(0, visibleCount - 1) * gap;
}

export function productionTopbarContentWidth(topbar: HTMLElement): number {
  const style = window.getComputedStyle(topbar);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const padding = (Number.parseFloat(style.paddingLeft) || 0)
    + (Number.parseFloat(style.paddingRight) || 0);
  let width = padding;
  let visibleCount = 0;

  for (const child of topbar.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (window.getComputedStyle(child).display === "none") continue;
    width += child.id === PRODUCTION_TOP_MENU_SLOT_ID
      ? productionToolbarContentWidth(child)
      : outerWidth(child);
    visibleCount += 1;
  }

  return width + Math.max(0, visibleCount - 1) * gap;
}

function lastVisibleToolbarChild(slot: HTMLElement): HTMLElement | null {
  const root = slot.querySelector<HTMLElement>("[data-production-top-menu-root]");
  if (!root) return null;
  const children = [...root.children].filter((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(child);
    return style.display !== "none" && style.position !== "absolute" && style.position !== "fixed";
  });
  return children.at(-1) ?? null;
}

/**
 * 除内容总宽外，再守住页面工具与全局搜索 / 更多之间的可见间距。
 * flex 子项的负 margin 会抵消父级 gap，却不会体现在 scrollWidth 中；只看总宽时，
 * 两组控件已经贴住甚至交叉仍会被判断为“放得下”。
 */
export function productionTopbarOverflow(topbar: HTMLElement): number {
  const contentOverflow = productionTopbarContentWidth(topbar) - topbar.clientWidth;
  const slot = topbar.querySelector<HTMLElement>(`#${PRODUCTION_TOP_MENU_SLOT_ID}`);
  const toolbarTail = slot ? lastVisibleToolbarChild(slot) : null;
  const globalActions = slot?.nextElementSibling instanceof HTMLElement
    ? slot.nextElementSibling
    : null;
  if (!toolbarTail || !globalActions || window.getComputedStyle(globalActions).display === "none") {
    return contentOverflow;
  }

  const visibleGap = globalActions.getBoundingClientRect().left - toolbarTail.getBoundingClientRect().right;
  const clearanceDeficit = PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX - visibleGap;
  return Math.max(contentOverflow, clearanceDeficit);
}
