// 编辑器下拉菜单（`/` 指令、`[[` `@` `#` 提及）的视口内定位——纯函数，组件只把
// 结果写进 style。菜单挂在 body portal 上，光标 rect 与视口同一坐标系，可直接比。
//
// 规则（#671）：
// - 下方放得下常规高度（或至少比上方宽裕）就向下开，否则向上开；
// - 左右夹在视口内（留 padding），宽度不超过视口；
// - 高度按所在一侧的余量缩，但**不低于 MIN_MENU_HEIGHT**：上方余量极小时若算成
//   0，菜单直接不可见——宁可盖住光标行也要让人看得见、点得到。

export type FloatingMenuLayout = {
  left: number;
  top: number;
  /** `top` 时调用方要配 `translateY(-100%)`：`top` 值是菜单**底边**的位置 */
  placement: "top" | "bottom";
  maxHeight: number;
  maxWidth: number;
};

/** 高度下限——低于这个值菜单只剩一两行，不如盖住光标 */
export const MIN_MENU_HEIGHT = 96;

/** 下方余量至少有这么多就优先向下开（与上方比大小只在两边都不够时才有意义） */
const PREFER_BELOW_HEIGHT = 192;

export function suggestionMenuLayout(
  anchor: Pick<DOMRect, "left" | "top" | "bottom">,
  viewport: { width: number; height: number },
  options: { width?: number; maxHeight?: number; gap?: number; padding?: number } = {},
): FloatingMenuLayout {
  const gap = options.gap ?? 4;
  const padding = options.padding ?? 8;
  const desiredHeight = options.maxHeight ?? 256;
  const width = Math.min(options.width ?? 360, Math.max(0, viewport.width - padding * 2));
  const roomAbove = Math.max(0, anchor.top - padding - gap);
  const roomBelow = Math.max(0, viewport.height - anchor.bottom - padding - gap);
  const placement: FloatingMenuLayout["placement"] =
    roomBelow >= Math.min(desiredHeight, PREFER_BELOW_HEIGHT) || roomBelow >= roomAbove ? "bottom" : "top";
  const room = placement === "bottom" ? roomBelow : roomAbove;
  const maxHeight = Math.max(MIN_MENU_HEIGHT, Math.min(desiredHeight, room));
  const left = Math.max(padding, Math.min(anchor.left, viewport.width - width - padding));
  const top = placement === "bottom" ? anchor.bottom + gap : anchor.top - gap;
  return { left, top, placement, maxHeight, maxWidth: width };
}
