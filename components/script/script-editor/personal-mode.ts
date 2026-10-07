import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

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

export function useStoredScriptPersonalMode(scriptId: string): [
  ScriptPersonalMode,
  Dispatch<SetStateAction<ScriptPersonalMode>>,
  boolean,
] {
  // `use client` 组件也会先 SSR。首帧不读 localStorage，并由调用方在 ready 前
  // 保持写入口锁定；否则弱网 hydration 前，记忆为只读的页面仍可直接输入。
  const [stored, setStored] = useState<{ scriptId: string; mode: ScriptPersonalMode } | null>(null);
  const ready = stored?.scriptId === scriptId;
  const mode = ready ? stored.mode : "edit";
  useEffect(() => {
    setStored({ scriptId, mode: readScriptPersonalMode(scriptId) });
  }, [scriptId]);
  const setMode = useCallback<Dispatch<SetStateAction<ScriptPersonalMode>>>((next) => {
    setStored((current) => {
      const currentMode = current?.scriptId === scriptId ? current.mode : "edit";
      return {
        scriptId,
        mode: typeof next === "function" ? next(currentMode) : next,
      };
    });
  }, [scriptId]);
  return [mode, setMode, ready];
}
