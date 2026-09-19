// 快捷键标签按平台渲染（#542）。
//
// 键盘处理本身早就两个键都认（`e.metaKey || e.ctrlKey`），问题只在**提示文案**
// 写死了 ⌘：Windows 用户按 Ctrl+F 能用，但菜单告诉他的是 ⌘F。
//
// 组合键用 `Mod+Shift+Z` 这种平台无关写法，渲染时再翻译：
//   Mac      → ⌘⇧Z        （符号连写，Apple HIG 习惯）
//   Windows  → Ctrl+Shift+Z（加号分隔）
//
// SSR 没有 navigator，先按 Mac 渲染；hydration 后 useSyncExternalStore 用客户端
// 快照校正——不会触发 hydration mismatch（React 在 hydrate 阶段用 getServerSnapshot）。

import { useSyncExternalStore } from "react";

export function detectMacLike(): boolean {
  if (typeof navigator === "undefined") return true;
  const uaData = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const MAC_KEYS: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Enter: "↵" };
const WIN_KEYS: Record<string, string> = { Mod: "Ctrl" };

/** `formatShortcut("Mod+Shift+Z", true)` → "⌘⇧Z"；`false` → "Ctrl+Shift+Z" */
export function formatShortcut(combo: string, mac: boolean): string {
  const parts = combo.split("+");
  return mac
    ? parts.map((p) => MAC_KEYS[p] ?? p).join("")
    : parts.map((p) => WIN_KEYS[p] ?? p).join("+");
}

const subscribeNoop = () => () => {};
const serverIsMac = () => true;

export function useIsMacLike(): boolean {
  return useSyncExternalStore(subscribeNoop, detectMacLike, serverIsMac);
}

export function useShortcutLabel(combo: string): string {
  return formatShortcut(combo, useIsMacLike());
}
