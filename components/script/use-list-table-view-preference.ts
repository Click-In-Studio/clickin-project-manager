"use client";

import { useCallback, useEffect, useState } from "react";

export type ListTableViewMode = "list" | "table";
export type ListTableViewScope = "dramaturgy" | "characters";

const STORAGE_KEY_PREFIX = "clickin:list-table-view";

export function listTableViewStorageKey(scope: ListTableViewScope) {
  return `${STORAGE_KEY_PREFIX}:${scope}`;
}

export function useListTableViewPreference(scope: ListTableViewScope) {
  const [view, setViewState] = useState<ListTableViewMode>("table");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(listTableViewStorageKey(scope));
      if (stored === "list" || stored === "table") setViewState(stored);
    } catch {
      // localStorage 被浏览器策略禁用时，仍保持首次进入默认表格。
    }
  }, [scope]);

  const setView = useCallback((next: ListTableViewMode) => {
    setViewState(next);
    try {
      window.localStorage.setItem(listTableViewStorageKey(scope), next);
    } catch {
      // 偏好保存失败不应阻止本次切换。
    }
  }, [scope]);

  return [view, setView] as const;
}
