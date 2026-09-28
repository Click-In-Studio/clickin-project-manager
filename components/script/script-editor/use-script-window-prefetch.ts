"use client";

import { useEffect } from "react";
import { fetchScriptWindow, fetchScriptWindowBootstrap } from "@/lib/script/script-client";
import { isMarkerBlock } from "@/lib/script/script-marker-blocks";
import type { Block } from "@/lib/script/script-types";
import { nextIdlePrefetchRange, type ScriptWindowRange } from "@/lib/script/script-window-prefetch";
import type { ScriptWindowBootstrap, ScriptWindowResponse } from "@/lib/script/script-window-types";

type MutableRef<T> = { current: T };

export type ScriptWindowRequest = {
  controller: AbortController;
  priority: "foreground" | "background";
};

export function useScriptWindowPrefetch({
  enabled,
  scriptId,
  versionId,
  syncWaitingForNetwork,
  initialWindowSize,
  blocksRef,
  viewportRange,
  windowRangeRef,
  manifestBlockIdsRef,
  loadedBlockIdsRef,
  requestRef,
  requestGenerationRef,
  orderRevisionRef,
  isSyncingRef,
  mergeWindow,
  applyBootstrap,
}: {
  enabled: boolean;
  scriptId: string;
  versionId: string | null;
  syncWaitingForNetwork: boolean;
  initialWindowSize: number;
  blocksRef: MutableRef<Block[]>;
  viewportRange: ScriptWindowRange;
  windowRangeRef: MutableRef<ScriptWindowRange>;
  manifestBlockIdsRef: MutableRef<Set<string>>;
  loadedBlockIdsRef: MutableRef<Set<string>>;
  requestRef: MutableRef<ScriptWindowRequest | null>;
  requestGenerationRef: MutableRef<number>;
  orderRevisionRef: MutableRef<string>;
  isSyncingRef: MutableRef<boolean>;
  mergeWindow: (body: ScriptWindowResponse) => boolean;
  applyBootstrap: (bootstrap: ScriptWindowBootstrap) => void;
}) {
  useEffect(() => {
    if (!enabled || !versionId || syncWaitingForNetwork) return;
    let cancelled = false;
    let dwellTimer: number | null = null;
    let idleHandle: number | null = null;

    const clearSchedule = () => {
      if (dwellTimer !== null) window.clearTimeout(dwellTimer);
      if (idleHandle !== null) window.cancelIdleCallback(idleHandle);
      dwellTimer = null;
      idleHandle = null;
    };
    const schedule = (delay: number) => {
      if (cancelled) return;
      clearSchedule();
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        if (typeof window.requestIdleCallback === "function") {
          idleHandle = window.requestIdleCallback(() => { idleHandle = null; void loadNext(); }, { timeout: 2500 });
        } else {
          void loadNext();
        }
      }, delay);
    };
    const loadNext = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden" || isSyncingRef.current || requestRef.current) {
        schedule(document.visibilityState === "hidden" ? 5000 : 500);
        return;
      }
      const target = nextIdlePrefetchRange(blocksRef.current.length, windowRangeRef.current, (index) => {
        const block = blocksRef.current[index];
        return Boolean(block && manifestBlockIdsRef.current.has(block.id)
          && !loadedBlockIdsRef.current.has(block.id) && !isMarkerBlock(block));
      });
      if (!target) return;

      const controller = new AbortController();
      requestRef.current = { controller, priority: "background" };
      const generation = ++requestGenerationRef.current;
      let retryDelay = 1000;
      try {
        const { status, body } = await fetchScriptWindow(
          scriptId, versionId, target.start, target.limit, orderRevisionRef.current, controller.signal,
        );
        if (cancelled || controller.signal.aborted || generation !== requestGenerationRef.current) return;
        if (!body) retryDelay = status === 409 ? 1000 : 10_000;
        if (status === 409 || !body || body.orderRevision !== orderRevisionRef.current || !mergeWindow(body)) {
          if (status !== 409 && !body) return;
          const bootstrap = await fetchScriptWindowBootstrap(
            scriptId, versionId, windowRangeRef.current.start, initialWindowSize, controller.signal,
          );
          if (!cancelled && !controller.signal.aborted && generation === requestGenerationRef.current && bootstrap) {
            applyBootstrap(bootstrap);
          }
        }
      } catch (error: unknown) {
        if (!(controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError"))) retryDelay = 10_000;
      } finally {
        if (requestRef.current?.controller === controller) requestRef.current = null;
        if (!cancelled) schedule(retryDelay);
      }
    };

    schedule(1000);
    return () => {
      cancelled = true;
      clearSchedule();
      if (requestRef.current?.priority === "background") {
        requestRef.current.controller.abort();
        requestRef.current = null;
      }
    };
  }, [applyBootstrap, blocksRef, enabled, initialWindowSize, isSyncingRef, loadedBlockIdsRef, manifestBlockIdsRef, mergeWindow,
    orderRevisionRef, requestGenerationRef, requestRef, scriptId, syncWaitingForNetwork, versionId, viewportRange, windowRangeRef]);
}
