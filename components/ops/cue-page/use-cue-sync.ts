"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { fetchListCues, patchCue } from "@/lib/ops/cue-client";
import { buildCuePatchBasis, normalizeCuePatch, type CueFieldPatch, type CuePatchBasis, type CueSaveStatus } from "@/lib/ops/cue-edit-types";
import type { Cue } from "@/lib/ops/cue-types";

type Save = { cue: Cue; fields: CueFieldPatch; basis: CuePatchBasis; status: CueSaveStatus };
type ListRead = { generation: number; epoch: number; writers: number; controller?: AbortController; retry?: ReturnType<typeof setTimeout> };

/** Cue 对账与保存共用写入边界；草稿保留自己的旧依据，不能借重连自动覆盖他人修改。 */
export function useCueSync({ productionId, versionId, initialCues, visibleListIdsRef, activeListIdRef }: {
  productionId: string; versionId?: string; initialCues: Cue[];
  visibleListIdsRef: MutableRefObject<Set<string>>; activeListIdRef: MutableRefObject<string | null>;
}) {
  const [cues, setCues] = useState(initialCues);
  const [saveStates, setSaveStates] = useState<Map<string, CueSaveStatus>>(new Map());
  const [readFailed, setReadFailed] = useState(false);
  const remoteRef = useRef(initialCues);
  const savesRef = useRef(new Map<string, Save[]>());
  const editingRef = useRef(new Map<string, { cue: Cue; count: number }>());
  const readsRef = useRef(new Map<string, ListRead>());
  const failedListsRef = useRef(new Set<string>());
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const savingRef = useRef(new Set<string>());
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextRef = useRef(0);
  const mountedRef = useRef(true);
  const readRef = useRef<(id: string) => void>(() => {});
  const saveRef = useRef<(id: string) => Promise<void>>(async () => {});

  const publish = useCallback(() => {
    if (!mountedRef.current) return;
    const display = new Map(remoteRef.current.map(cue => [cue.id, cue]));
    // 对账删除了正在编辑的 Cue，也不能使输入框突然卸载丢掉草稿；提交时由服务端报冲突。
    for (const [id, { cue }] of editingRef.current) if (!display.has(id)) display.set(id, cue);
    for (const [id, queue] of savesRef.current) {
      let cue = display.get(id) ?? queue[0].cue;
      for (const save of queue) cue = { ...cue, ...save.fields };
      display.set(id, cue);
    }
    setCues([...display.values()]);
    setSaveStates(new Map([...savesRef.current].map(([id, queue]) => [id, queue[0].status])));
    setReadFailed(failedListsRef.current.size > 0);
  }, []);
  const listState = useCallback((id: string) => {
    let state = readsRef.current.get(id);
    if (!state) { state = { generation: 0, epoch: 0, writers: 0 }; readsRef.current.set(id, state); }
    return state;
  }, []);
  const listIds = useCallback(() => {
    const ids = new Set(visibleListIdsRef.current);
    if (activeListIdRef.current) ids.add(activeListIdRef.current);
    return ids;
  }, [activeListIdRef, visibleListIdsRef]);
  const scheduleCueRefetch = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      for (const id of listIds()) readRef.current(id);
    }, 300);
  }, [listIds]);

  const beginListWrite = useCallback((listId: string) => {
    const state = listState(listId);
    const context = contextRef.current;
    state.writers++;
    state.epoch++;
    const epoch = state.epoch;
    state.controller?.abort();
    let finished = false;
    return (apply?: () => void) => {
      if (finished || context !== contextRef.current) return;
      finished = true;
      if (state.epoch === epoch && state.writers === 1) apply?.();
      state.writers--;
      state.epoch++;
      scheduleCueRefetch();
    };
  }, [listState, scheduleCueRefetch]);

  readRef.current = async (id: string) => {
    if (!mountedRef.current || !listIds().has(id)) return;
    const state = listState(id);
    if (state.writers > 0) return; // 写入收尾会重新安排；不读可能先于保存的快照。
    if (state.retry) clearTimeout(state.retry);
    state.retry = undefined;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const generation = ++state.generation, epoch = state.epoch, context = contextRef.current;
    const fresh = await fetchListCues(productionId, id, versionId, controller.signal);
    if (!mountedRef.current || controller.signal.aborted || context !== contextRef.current
      || generation !== state.generation || epoch !== state.epoch || !listIds().has(id)) return;
    state.controller = undefined;
    if (fresh === null) {
      failedListsRef.current.add(id);
      state.retry = setTimeout(() => readRef.current(id), 2000);
    } else {
      failedListsRef.current.delete(id);
      remoteRef.current = [...remoteRef.current.filter(cue => cue.cueListId !== id), ...fresh];
    }
    publish();
  };

  saveRef.current = async (id: string) => {
    if (!mountedRef.current || savingRef.current.has(id)) return;
    const save = savesRef.current.get(id)?.[0];
    if (!save || save.status === "conflict" || save.status === "failed") return;
    const context = contextRef.current;
    const timer = saveTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(id);
    savingRef.current.add(id);
    save.status = "saving";
    const finish = beginListWrite(save.cue.cueListId);
    publish();
    const result = await patchCue(productionId, save.cue.cueListId, id, versionId, save.fields, save.basis);
    if (!mountedRef.current || context !== contextRef.current) return;
    finish();
    savingRef.current.delete(id);
    if (result.ok) {
      // 响应携带事务内确认的 Cue，服务端 trim 后的值也成为下一次编辑依据。
      remoteRef.current = [...remoteRef.current.filter(cue => cue.id !== id), result.cue];
      const queue = savesRef.current.get(id)!;
      queue.shift();
      if (queue.length === 0) savesRef.current.delete(id);
      else void saveRef.current(id);
    } else {
      save.status = result.status === 409 ? "conflict"
        : result.status === 0 || result.status >= 500 ? "waiting" : "failed";
      if (save.status === "waiting") {
        saveTimersRef.current.set(id, setTimeout(() => {
          saveTimersRef.current.delete(id);
          void saveRef.current(id); // 沿用旧依据；不能以新的线上快照重新包装草稿。
        }, 2000));
      }
    }
    publish();
  };

  const updateCueField = useCallback(async (cue: Cue, fields: CueFieldPatch, original?: CuePatchBasis) => {
    const queue = savesRef.current.get(cue.id) ?? [];
    queue.push({ cue, fields: normalizeCuePatch(fields), basis: original ?? buildCuePatchBasis(cue, fields), status: "saving" });
    savesRef.current.set(cue.id, queue);
    publish();
    await saveRef.current(cue.id);
  }, [publish]);
  const editingCue = useCallback((cue: Cue, editing: boolean) => {
    const current = editingRef.current.get(cue.id);
    if (editing) editingRef.current.set(cue.id, { cue: current?.cue ?? cue, count: (current?.count ?? 0) + 1 });
    else if (current && current.count > 1) current.count--;
    else editingRef.current.delete(cue.id);
    publish();
  }, [publish]);
  const replaceListCues = useCallback((listId: string, fresh: Cue[]) => {
    remoteRef.current = [...remoteRef.current.filter(cue => cue.cueListId !== listId), ...fresh];
    publish();
  }, [publish]);
  const removeCue = useCallback((id: string) => {
    remoteRef.current = remoteRef.current.filter(cue => cue.id !== id);
    publish();
  }, [publish]);
  const retry = useCallback(() => {
    for (const [id, queue] of savesRef.current) {
      if (queue[0].status === "waiting" || queue[0].status === "failed") {
        const timer = saveTimersRef.current.get(id);
        if (timer) clearTimeout(timer);
        saveTimersRef.current.delete(id);
        queue[0].status = "waiting";
        void saveRef.current(id);
      }
    }
    scheduleCueRefetch();
  }, [scheduleCueRefetch]);
  const discardConflicts = useCallback(() => {
    for (const [id, queue] of savesRef.current) {
      if (queue[0].status === "conflict" || queue[0].status === "failed") savesRef.current.delete(id);
    }
    publish();
    scheduleCueRefetch();
  }, [publish, scheduleCueRefetch]);

  useEffect(() => {
    mountedRef.current = true;
    remoteRef.current = initialCues;
    publish();
    const context = contextRef;
    const reads = readsRef.current, saves = savesRef.current, editing = editingRef.current;
    const failedLists = failedListsRef.current, timers = saveTimersRef.current, saving = savingRef.current;
    return () => {
      mountedRef.current = false;
      context.current++;
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      for (const state of reads.values()) {
        state.controller?.abort();
        if (state.retry) clearTimeout(state.retry);
      }
      for (const timer of timers.values()) clearTimeout(timer);
      reads.clear();
      saves.clear();
      editing.clear();
      failedLists.clear();
      timers.clear();
      saving.clear();
    };
  }, [productionId, versionId, publish]); // eslint-disable-line react-hooks/exhaustive-deps

  return { cues, saveStates, readFailed, updateCueField, editingCue, scheduleCueRefetch,
    beginListWrite, replaceListCues, removeCue, retry, discardConflicts };
}
