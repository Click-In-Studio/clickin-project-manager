/**
 * 水印 tile 生成（SVG data URI，供 CSS background 平铺）。
 * 屏幕水印 overlay 与打印水印共用此实现。
 */

export const WATERMARK_TILE_W = 420;
export const WATERMARK_TILE_H = 260;

export function buildWatermarkTile(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  // 两行错位排布，-22° 旋转；中性灰低不透明度，屏幕深浅主题与纸面打印通用
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WATERMARK_TILE_W}" height="${WATERMARK_TILE_H}">` +
    `<text x="36" y="110" transform="rotate(-22 36 110)" ` +
    `font-family="system-ui, -apple-system, sans-serif" font-size="17" ` +
    `fill="#888888" fill-opacity="0.12">${esc}</text>` +
    `<text x="${36 + WATERMARK_TILE_W / 2}" y="${110 + WATERMARK_TILE_H / 2}" transform="rotate(-22 ${36 + WATERMARK_TILE_W / 2} ${110 + WATERMARK_TILE_H / 2})" ` +
    `font-family="system-ui, -apple-system, sans-serif" font-size="17" ` +
    `fill="#888888" fill-opacity="0.12">${esc}</text>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
