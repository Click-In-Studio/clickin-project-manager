"use client";

import { useCallback, useLayoutEffect, useState } from "react";

export type ListTableViewMode = "list" | "table";
export type ListTableViewScope = "dramaturgy" | "characters";

const STORAGE_KEY_PREFIX = "clickin:list-table-view";

export function listTableViewStorageKey(scope: ListTableViewScope) {
  return `${STORAGE_KEY_PREFIX}:${scope}`;
}

export function useListTableViewPreference(scope: ListTableViewScope) {
  const [preference, setPreference] = useState<{
    scope: ListTableViewScope;
    view: ListTableViewMode | null;
  }>({ scope, view: null });
  const view = preference.scope === scope ? preference.view : null;

  useLayoutEffect(() => {
    let next: ListTableViewMode = "table";
    try {
      const stored = window.localStorage.getItem(listTableViewStorageKey(scope));
      if (stored === "list" || stored === "table") next = stored;
    } catch {
      // localStorage 被浏览器策略禁用时使用默认表格。
    }
    setPreference({ scope, view: next });
  }, [scope]);

  const setView = useCallback((next: ListTableViewMode) => {
    setPreference({ scope, view: next });
    try {
      window.localStorage.setItem(listTableViewStorageKey(scope), next);
    } catch {
      // 偏好保存失败不应阻止本次切换。
    }
  }, [scope]);

  return [view, setView] as const;
}
