export type FloatingMenuLayout = {
  left: number;
  top: number;
  placement: "top" | "bottom";
  maxHeight: number;
  maxWidth: number;
};

/**
 * Suggestion menus live in a body portal, so the caret rect and viewport share
 * the same coordinate system. Pick the side with enough room, clamp the menu
 * horizontally, and shrink its scroll area when neither side fits completely.
 */
export function suggestionMenuLayout(
  anchor: Pick<DOMRect, "left" | "top" | "bottom">,
  viewport: { width: number; height: number },
  options: { width?: number; maxHeight?: number; gap?: number; padding?: number } = {},
): FloatingMenuLayout {
  const width = Math.min(options.width ?? 360, Math.max(0, viewport.width - 16));
  const desiredHeight = options.maxHeight ?? 256;
  const gap = options.gap ?? 4;
  const padding = options.padding ?? 8;
  const roomAbove = Math.max(0, anchor.top - padding - gap);
  const roomBelow = Math.max(0, viewport.height - anchor.bottom - padding - gap);
  const placement = roomBelow >= Math.min(desiredHeight, 192) || roomBelow >= roomAbove
    ? "bottom"
    : "top";
  const maxHeight = Math.max(0, Math.min(desiredHeight, placement === "bottom" ? roomBelow : roomAbove));
  const left = Math.max(padding, Math.min(anchor.left, viewport.width - width - padding));
  const top = placement === "bottom" ? anchor.bottom + gap : anchor.top - gap;
  return { left, top, placement, maxHeight, maxWidth: width };
}
