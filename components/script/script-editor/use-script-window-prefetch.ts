"use client";

import { useEffect } from "react";
import { fetchScriptWindow, fetchScriptWindowBootstrap } from "@/lib/script/script-client";
import { isMarkerBlock } from "@/lib/script/script-marker-blocks";
import type { ScriptWindowRequests } from "./script-window-requests";
import type { ScriptDocument } from "./script-document";
import { nextIdlePrefetchRange, type ScriptWindowRange } from "@/lib/script/script-window-prefetch";
import type { ScriptWindowBootstrap, ScriptWindowResponse } from "@/lib/script/script-window-types";

type MutableRef<T> = { current: T };

export function useScriptWindowPrefetch({
  enabled,
  scriptId,
  versionId,
  syncWaitingForNetwork,
  initialWindowSize,
  script,
  isSaving,
  viewportRange,
  windowRangeRef,
  requests,
  mergeWindow,
  applyBootstrap,
}: {
  enabled: boolean;
  scriptId: string;
  versionId: string | null;
  syncWaitingForNetwork: boolean;
  initialWindowSize: number;
  script: ScriptDocument;
  isSaving: () => boolean;
  viewportRange: ScriptWindowRange;
  windowRangeRef: MutableRef<ScriptWindowRange>;
  requests: ScriptWindowRequests;
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
      if (document.visibilityState === "hidden" || isSaving() || requests.isBusy()) {
        schedule(document.visibilityState === "hidden" ? 5000 : 500);
        return;
      }
      const target = nextIdlePrefetchRange(script.getSnapshot().blocks.length, windowRangeRef.current, (index) => {
        const block = script.getSnapshot().blocks[index];
        return Boolean(block && script.getSnapshot().manifestIds.has(block.id)
          && !script.getSnapshot().loadedIds.has(block.id) && !isMarkerBlock(block));
      });
      if (!target) return;

      const request = requests.begin("background");
      const { controller } = request;
      let retryDelay = 1000;
      try {
        const { status, body } = await fetchScriptWindow(
          scriptId, versionId, target.start, target.limit, script.getSnapshot().orderRevision, controller.signal,
        );
        if (cancelled || controller.signal.aborted || !requests.isCurrent(request)) return;
        if (!body) retryDelay = status === 409 ? 1000 : 10_000;
        if (status === 409 || !body || body.orderRevision !== script.getSnapshot().orderRevision || !mergeWindow(body)) {
          if (status !== 409 && !body) return;
          const bootstrap = await fetchScriptWindowBootstrap(
            scriptId, versionId, windowRangeRef.current.start, initialWindowSize, controller.signal,
          );
          if (!cancelled && !controller.signal.aborted && requests.isCurrent(request) && bootstrap) {
            applyBootstrap(bootstrap);
          }
        }
      } catch (error: unknown) {
        if (!(controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError"))) retryDelay = 10_000;
      } finally {
        requests.finish(request);
        if (!cancelled) schedule(retryDelay);
      }
    };

    schedule(1000);
    return () => {
      cancelled = true;
      clearSchedule();
      requests.cancelBackground();
    };
  }, [applyBootstrap, script, enabled, initialWindowSize, isSaving, mergeWindow,
    requests, scriptId, syncWaitingForNetwork, versionId, viewportRange, windowRangeRef]);
}
