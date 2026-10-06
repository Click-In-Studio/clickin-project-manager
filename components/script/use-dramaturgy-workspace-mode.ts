"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type DramaturgyWorkspaceMode = "read" | "edit";

const STORAGE_KEY_PREFIX = "clickin:dramaturgy-workspace-mode";

export function dramaturgyWorkspaceModeStorageKey(productionId: string) {
  return `${STORAGE_KEY_PREFIX}:${productionId}`;
}

function messageOf(error: unknown) {
  return error instanceof Error && error.message ? error.message : "保存失败，请重试";
}

export function useDramaturgyWorkspaceMode(productionId: string, hasWritePermission: boolean) {
  const defaultMode: DramaturgyWorkspaceMode = hasWritePermission ? "edit" : "read";
  const [storedMode, setStoredMode] = useState<DramaturgyWorkspaceMode>(defaultMode);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(new Set<Promise<unknown>>());
  const writeSequenceRef = useRef(0);
  const failureRef = useRef<{ sequence: number; error: unknown } | null>(null);
  const storageKey = dramaturgyWorkspaceModeStorageKey(productionId);

  useLayoutEffect(() => {
    let next = defaultMode;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === "read" || saved === "edit") next = saved;
    } catch {
      // 存储被禁用时沿用当前会话默认值。
    }
    setStoredMode(next);
  }, [defaultMode, storageKey]);

  const persist = useCallback((next: DramaturgyWorkspaceMode) => {
    setStoredMode(next);
    try { window.localStorage.setItem(storageKey, next); } catch {
      // 偏好保存失败不阻止本次切换。
    }
  }, [storageKey]);

  const trackWrite = useCallback(<T,>(operation: Promise<T>): Promise<T> => {
    const sequence = ++writeSequenceRef.current;
    const tracked = operation.then((value) => {
      if (!failureRef.current || failureRef.current.sequence < sequence) {
        failureRef.current = null;
        setError(null);
      }
      return value;
    }).catch((caught) => {
      failureRef.current = { sequence, error: caught };
      setError(messageOf(caught));
      throw caught;
    }).finally(() => {
      pendingRef.current.delete(tracked);
    });
    pendingRef.current.add(tracked);
    return tracked;
  }, []);

  const requestMode = useCallback(async (next: DramaturgyWorkspaceMode) => {
    if (next === "edit") {
      if (hasWritePermission) {
        setError(null);
        persist("edit");
      }
      return;
    }
    if (storedMode === "read" || switching) return;

    setSwitching(true);
    setError(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    await Promise.resolve();

    while (pendingRef.current.size > 0) {
      await Promise.allSettled([...pendingRef.current]);
    }
    if (failureRef.current) {
      setError(messageOf(failureRef.current.error));
      setSwitching(false);
      return;
    }

    const dirty = document.querySelector<HTMLElement>("[data-dramaturgy-unsaved='true']");
    if (dirty) {
      setError(dirty.dataset.dramaturgyUnsavedMessage ?? "请先保存或取消当前输入，再切换只读");
      dirty.querySelector<HTMLElement>("input,textarea,button")?.focus();
      setSwitching(false);
      return;
    }

    persist("read");
    setSwitching(false);
  }, [hasWritePermission, persist, storedMode, switching]);

  return {
    mode: hasWritePermission ? storedMode : "read" as DramaturgyWorkspaceMode,
    switching,
    error,
    requestMode,
    trackWrite,
  };
}
