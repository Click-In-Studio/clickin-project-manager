"use client";

/**
 * 全页平铺水印（参考飞书等主流 SaaS）+ MutationObserver 守护：
 * - [用户名 邮箱] 斜向平铺，低透明度；pointer-events/user-select none 零交互拦截
 * - 节点由脚本挂在 document.body 直下（React 树外）：删父容器不连带、无 hydration 冲突
 * - 守护三层：① body childList 观察——节点被移除立即以新随机 id 重建
 *   ② 节点 attributes 观察——style/class 被篡改立即回写
 *   ③ 低频 interval 兜底——observer 本身被 disconnect 时自愈
 * - 客户端水印无绝对防御（本地环境永远可绕），此处只提高删除成本；
 *   硬保证走服务端出口烧水印（导出/下载），见产品规划。
 */

import { useEffect } from "react";

// 2026-08-16 用户反馈：太密太深影响读信息——瓦片放大约 1.5 倍、透明度 0.12→0.07
const TILE_W = 640;
const TILE_H = 400;

function buildTile(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">` +
    `<text x="36" y="110" transform="rotate(-22 36 110)" ` +
    `font-family="system-ui, -apple-system, sans-serif" font-size="17" ` +
    `fill="#888888" fill-opacity="0.07">${esc}</text>` +
    `<text x="${36 + TILE_W / 2}" y="${110 + TILE_H / 2}" transform="rotate(-22 ${36 + TILE_W / 2} ${110 + TILE_H / 2})" ` +
    `font-family="system-ui, -apple-system, sans-serif" font-size="17" ` +
    `fill="#888888" fill-opacity="0.07">${esc}</text>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function applyStyle(el: HTMLElement, tile: string) {
  const s = el.style;
  s.setProperty("position", "fixed", "important");
  s.setProperty("inset", "0", "important");
  s.setProperty("z-index", "2147483000", "important");
  s.setProperty("pointer-events", "none", "important");
  s.setProperty("user-select", "none", "important");
  s.setProperty("background-image", tile, "important");
  s.setProperty("background-repeat", "repeat", "important");
  s.setProperty("display", "block", "important");
  s.setProperty("opacity", "1", "important");
  s.setProperty("visibility", "visible", "important");
}

export default function WatermarkOverlay({ name, email }: { name: string; email: string | null }) {
  const text = email ? `${name} ${email}` : name;

  useEffect(() => {
    if (!text.trim()) return;
    const tile = buildTile(text);
    let node: HTMLDivElement | null = null;
    let nodeObserver: MutationObserver | null = null;
    let alive = true;

    const mount = () => {
      if (!alive) return;
      nodeObserver?.disconnect();
      node = document.createElement("div");
      node.id = `wm-${Math.random().toString(36).slice(2)}`;
      node.setAttribute("aria-hidden", "true");
      applyStyle(node, tile);
      document.body.appendChild(node);
      // ② 属性篡改回写
      nodeObserver = new MutationObserver(() => {
        if (node) applyStyle(node, tile);
      });
      nodeObserver.observe(node, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
    };

    mount();

    // ① 节点被移除 → 重建
    const bodyObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const removed of m.removedNodes) {
          if (removed === node) { mount(); return; }
        }
      }
    });
    bodyObserver.observe(document.body, { childList: true });

    // ③ observer 被断的兜底自愈
    const timer = setInterval(() => {
      if (!node || !document.body.contains(node)) mount();
      else applyStyle(node, tile);
    }, 2000);

    return () => {
      alive = false;
      clearInterval(timer);
      bodyObserver.disconnect();
      nodeObserver?.disconnect();
      node?.remove();
    };
  }, [text]);

  return null;
}
