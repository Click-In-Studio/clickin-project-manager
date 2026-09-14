import { getOrCreateClientId } from "./presence";

// ── Display settings (cookie-persisted) ───────────────────────────────────────
export type DisplaySettings = {
  pageBreaks: boolean;
  lineNumbers: boolean;
  blockTags: boolean;
  rehearsalMode: boolean;
  rehearsalBlockScenes: boolean;
  sceneDetail: boolean;
};
export const DEFAULT_DISPLAY: DisplaySettings = {
  pageBreaks: true,
  lineNumbers: true,
  blockTags: true,
  rehearsalMode: false,
  rehearsalBlockScenes: true,
  sceneDetail: true,
};
export const DISPLAY_COOKIE = "script_display";
export const CHARACTER_FOCUS_STORAGE_PREFIX = "script_character_focus";
export function readDisplayCookie(): DisplaySettings {
  try {
    const m = document.cookie.match(/(?:^|;\s*)script_display=([^;]*)/);
    if (m) return { ...DEFAULT_DISPLAY, ...JSON.parse(decodeURIComponent(m[1])) };
  } catch { /* ignore */ }
  return DEFAULT_DISPLAY;
}
export function writeDisplayCookie(s: DisplaySettings) {
  document.cookie = `${DISPLAY_COOKIE}=${encodeURIComponent(JSON.stringify(s))}; path=/; max-age=31536000; SameSite=Lax`;
}

export function characterFocusStorageKey(scriptId: string): string {
  return `${CHARACTER_FOCUS_STORAGE_PREFIX}:${scriptId}:${getOrCreateClientId()}`;
}

export function readStoredCharacterFocus(scriptId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(characterFocusStorageKey(scriptId));
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeStoredCharacterFocus(scriptId: string, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    const key = characterFocusStorageKey(scriptId);
    if (ids.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(Array.from(ids)));
  } catch { /* ignore storage failures */ }
}
