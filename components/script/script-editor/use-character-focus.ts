"use client";

import { useState, useEffect, useCallback } from "react";
import type { Character } from "@/lib/script/script-types";
import { readStoredCharacterFocus, writeStoredCharacterFocus } from "./display-settings";

export type PendingAggregateFocusPrompt = {
  characterId: string;
  aggregateIds: string[];
  selectedIds: Set<string>;
};

/**
 * 角色聚焦：勾选的角色集合按剧本 id 存 localStorage；勾中一个被聚合角色包含的成员时弹出
 * 「是否连同聚合角色一起聚焦」的提示（确认 / 全选 / 取消三条出路）。
 * 从 ScriptEditor 主函数体原样搬出（#487 S5）。
 */
export function useCharacterFocus({ effectiveScriptId, characters }: { effectiveScriptId: string; characters: Character[] }) {
  const [focusedCharacterIds, setFocusedCharacterIds] = useState<Set<string>>(() => readStoredCharacterFocus(effectiveScriptId));
  const [pendingAggregateFocusPrompt, setPendingAggregateFocusPrompt] = useState<PendingAggregateFocusPrompt | null>(null);
  useEffect(() => {
    setFocusedCharacterIds(readStoredCharacterFocus(effectiveScriptId));
    setPendingAggregateFocusPrompt(null);
  }, [effectiveScriptId]);
  const setAndStoreFocusedCharacterIds = useCallback((ids: Set<string>) => {
    setFocusedCharacterIds(ids);
    writeStoredCharacterFocus(effectiveScriptId, ids);
  }, [effectiveScriptId]);
  const toggleCharacterFocus = useCallback((id: string) => {
    const ids = new Set(focusedCharacterIds);
    if (ids.has(id)) {
      ids.delete(id);
      setAndStoreFocusedCharacterIds(ids);
      setPendingAggregateFocusPrompt((prompt) => prompt?.characterId === id ? null : prompt);
      return;
    }

    ids.add(id);
    setAndStoreFocusedCharacterIds(ids);

    const aggregateIds = characters
      .filter((char) => char.isAggregate && (char.memberIds ?? []).includes(id) && !focusedCharacterIds.has(char.id))
      .map((char) => char.id);
    if (aggregateIds.length > 0) {
      setPendingAggregateFocusPrompt({
        characterId: id,
        aggregateIds,
        selectedIds: new Set(),
      });
    }
  }, [characters, focusedCharacterIds, setAndStoreFocusedCharacterIds]);
  const clearCharacterFocus = useCallback(() => {
    setAndStoreFocusedCharacterIds(new Set());
  }, [setAndStoreFocusedCharacterIds]);
  const confirmAggregateFocusPrompt = useCallback(() => {
    if (!pendingAggregateFocusPrompt) return;
    const ids = new Set(focusedCharacterIds);
    ids.add(pendingAggregateFocusPrompt.characterId);
    for (const aggregateId of pendingAggregateFocusPrompt.selectedIds) ids.add(aggregateId);
    setAndStoreFocusedCharacterIds(ids);
    setPendingAggregateFocusPrompt(null);
  }, [focusedCharacterIds, pendingAggregateFocusPrompt, setAndStoreFocusedCharacterIds]);
  const addAllAggregateFocusPrompt = useCallback(() => {
    if (!pendingAggregateFocusPrompt) return;
    const ids = new Set(focusedCharacterIds);
    ids.add(pendingAggregateFocusPrompt.characterId);
    for (const aggregateId of pendingAggregateFocusPrompt.aggregateIds) ids.add(aggregateId);
    setAndStoreFocusedCharacterIds(ids);
    setPendingAggregateFocusPrompt(null);
  }, [focusedCharacterIds, pendingAggregateFocusPrompt, setAndStoreFocusedCharacterIds]);
  const cancelAggregateFocusPrompt = useCallback(() => {
    if (!pendingAggregateFocusPrompt) return;
    const ids = new Set(focusedCharacterIds);
    ids.add(pendingAggregateFocusPrompt.characterId);
    for (const aggregateId of pendingAggregateFocusPrompt.aggregateIds) ids.delete(aggregateId);
    setAndStoreFocusedCharacterIds(ids);
    setPendingAggregateFocusPrompt(null);
  }, [focusedCharacterIds, pendingAggregateFocusPrompt, setAndStoreFocusedCharacterIds]);
  const togglePendingAggregateFocus = useCallback((id: string) => {
    setPendingAggregateFocusPrompt((prompt) => {
      if (!prompt) return prompt;
      const selectedIds = new Set(prompt.selectedIds);
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      return { ...prompt, selectedIds };
    });
  }, []);

  return {
    focusedCharacterIds, pendingAggregateFocusPrompt,
    toggleCharacterFocus, clearCharacterFocus,
    confirmAggregateFocusPrompt, addAllAggregateFocusPrompt, cancelAggregateFocusPrompt, togglePendingAggregateFocus,
  };
}
