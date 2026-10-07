"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { writeDisplayCookie, type DisplaySettings } from "./display-settings";
import { writeScriptPersonalMode, type ScriptPersonalMode } from "./personal-mode";

export function useScriptPersonalModeTransition({
  scriptId,
  baseCanEdit,
  personalMode,
  rehearsalMode,
  setPersonalMode,
  setRehearsalMode,
  setDisplay,
  flushPendingPatch,
  captureScrollAnchor,
  preserveScrollAnchor,
  resetInteractions,
  closeMenu,
}: {
  scriptId: string;
  baseCanEdit: boolean;
  personalMode: ScriptPersonalMode;
  rehearsalMode: boolean;
  setPersonalMode: Dispatch<SetStateAction<ScriptPersonalMode>>;
  setRehearsalMode: Dispatch<SetStateAction<boolean>>;
  setDisplay: Dispatch<SetStateAction<DisplaySettings>>;
  flushPendingPatch: () => Promise<boolean>;
  captureScrollAnchor: () => { id: string; top: number } | null;
  preserveScrollAnchor: (anchor: { id: string; top: number } | null) => void;
  resetInteractions: () => void;
  closeMenu: () => void;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const selectMode = useCallback(async (nextMode: ScriptPersonalMode) => {
    if (nextMode === "edit" && !baseCanEdit) return;
    if (nextMode === personalMode && !rehearsalMode) {
      closeMenu();
      return;
    }
    setError("");
    setPending(true);
    try {
      if (nextMode === "read" && personalMode === "edit" && !rehearsalMode && !await flushPendingPatch()) {
        setError("尚有内容未保存，已保留编辑模式，请稍后重试。");
        return;
      }
      preserveScrollAnchor(captureScrollAnchor());
      resetInteractions();
      setPersonalMode(nextMode);
      writeScriptPersonalMode(scriptId, nextMode);
      if (rehearsalMode) {
        setRehearsalMode(false);
        setDisplay((previous) => {
          const next = { ...previous, rehearsalMode: false };
          writeDisplayCookie(next);
          return next;
        });
      }
      closeMenu();
    } catch {
      setError("保存失败，已保留编辑模式和当前内容，请稍后重试。");
    } finally {
      setPending(false);
    }
  }, [baseCanEdit, captureScrollAnchor, closeMenu, flushPendingPatch, personalMode, preserveScrollAnchor, rehearsalMode, resetInteractions, scriptId, setDisplay, setPersonalMode, setRehearsalMode]);

  return { error, pending, clearError: () => setError(""), selectMode };
}
