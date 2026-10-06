export type ScriptPersonalMode = "edit" | "read";

const STORAGE_PREFIX = "clickin:script-personal-mode";

function storageKey(scriptId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(scriptId)}`;
}

export function readScriptPersonalMode(scriptId: string): ScriptPersonalMode {
  if (typeof window === "undefined") return "edit";
  try {
    return window.localStorage.getItem(storageKey(scriptId)) === "read" ? "read" : "edit";
  } catch {
    return "edit";
  }
}

export function writeScriptPersonalMode(scriptId: string, mode: ScriptPersonalMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(scriptId), mode);
  } catch {
    // Storage can be unavailable in private/restricted browsing; the in-memory mode still works.
  }
}
