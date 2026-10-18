"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { writeScriptPersonalMode, type ScriptPersonalMode } from "./personal-mode";

export function useScriptPersonalModeTransition({
  scriptId,
  baseCanEdit,
  personalMode,
  setPersonalMode,
  flushPendingPatch,
  captureScrollAnchor,
  preserveScrollAnchor,
  resetInteractions,
  closeMenu,
}: {
  scriptId: string;
  baseCanEdit: boolean;
  personalMode: ScriptPersonalMode;
  setPersonalMode: Dispatch<SetStateAction<ScriptPersonalMode>>;
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
    if (nextMode === personalMode) {
      closeMenu();
      return;
    }
    setError("");
    setPending(true);
    try {
      if (nextMode === "read" && personalMode === "edit" && !await flushPendingPatch()) {
        setError("尚有内容未保存，已保留编辑模式，请稍后重试。");
        return;
      }
      preserveScrollAnchor(captureScrollAnchor());
      resetInteractions();
      setPersonalMode(nextMode);
      writeScriptPersonalMode(scriptId, nextMode);
      closeMenu();
    } catch {
      setError("保存失败，已保留编辑模式和当前内容，请稍后重试。");
    } finally {
      setPending(false);
    }
  }, [baseCanEdit, captureScrollAnchor, closeMenu, flushPendingPatch, personalMode, preserveScrollAnchor, resetInteractions, scriptId, setPersonalMode]);

  return { error, pending, clearError: () => setError(""), selectMode };
}
