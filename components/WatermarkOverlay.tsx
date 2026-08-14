/**
 * 全页平铺水印（参考飞书等主流 SaaS）：
 * - [用户名 邮箱] 斜向平铺，低透明度，不干扰阅读
 * - pointer-events: none + user-select: none —— 零交互拦截
 * - SVG data URI 作背景 tile，服务端可渲染（无 "use client"）
 * - aria-hidden：对辅助技术不可见
 */

const TILE_W = 320;
const TILE_H = 180;

function buildTile(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  // 两行错位排布，-22° 旋转；fill 用中性灰、低不透明度，深浅色主题下都可读且不扎眼
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">` +
    `<text x="30" y="80" transform="rotate(-22 30 80)" ` +
    `font-family="system-ui, -apple-system, sans-serif" font-size="13" ` +
    `fill="#888888" fill-opacity="0.13">${esc}</text>` +
    `<text x="${30 + TILE_W / 2}" y="${80 + TILE_H / 2}" transform="rotate(-22 ${30 + TILE_W / 2} ${80 + TILE_H / 2})" ` +
    `font-family="system-ui, -apple-system, sans-serif" font-size="13" ` +
    `fill="#888888" fill-opacity="0.13">${esc}</text>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export default function WatermarkOverlay({ name, email }: { name: string; email: string | null }) {
  const text = email ? `${name} ${email}` : name;
  if (!text.trim()) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        pointerEvents: "none",
        userSelect: "none",
        backgroundImage: buildTile(text),
        backgroundRepeat: "repeat",
      }}
    />
  );
}
