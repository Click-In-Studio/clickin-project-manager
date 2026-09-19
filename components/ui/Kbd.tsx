"use client";

import { useShortcutLabel } from "./shortcut-label";

/** `<Kbd combo="Mod+Z" />` → Mac 显示 ⌘Z，Windows 显示 Ctrl+Z。样式由调用方给。 */
export default function Kbd({ combo, className }: { combo: string; className?: string }) {
  return <kbd className={className}>{useShortcutLabel(combo)}</kbd>;
}
