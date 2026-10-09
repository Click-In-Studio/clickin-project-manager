"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { useVisibleEventSource } from "@/hooks/useVisibleEventSource";
import type { MarkerDeleteOperation, MarkerProjection } from "@/lib/script/script-marker-domain";
import type { MarkerDeleteDialogState } from "./MarkerDeleteDialog";

/** 表格结构写入沿用列表的 REST 契约，展示顺序只接受服务端结果。 */
export function useSceneTableStructure({
  productionId, versionId, scenes, openingChapterMarkerId, onScenesChange, trackWrite,
}: {
  productionId: string;
  versionId: string | null;
  scenes: MarkerProjection[];
  openingChapterMarkerId: string | null;
  onScenesChange: (scenes: MarkerProjection[]) => void;
  trackWrite: <T,>(operation: Promise<T>) => Promise<T>;
}) {
  const [busy, setBusy] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState(false);
  const writeBlockedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<MarkerDeleteDialogState | null>(null);
  const busyRef = useRef(false);
  const readSequence = useRef(0);
  const refreshQueued = useRef(false);
  const endpoint = `${BASE_PATH}/api/production/${productionId}/scenes`;

  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    try {
      const response = await fetch(`${endpoint}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`);
      if (!response.ok || response.status === 202) throw new Error("未能同步章节和段落，请重试");
      const data = await response.json() as MarkerProjection[];
      if (!Array.isArray(data)) throw new Error("服务端未返回章节和段落，请重试同步");
      if (sequence === readSequence.current && !busyRef.current) {
        onScenesChange(data);
        writeBlockedRef.current = false;
        setWriteBlocked(false);
      }
    } catch (caught) {
      if (sequence === readSequence.current) {
        writeBlockedRef.current = true;
        setWriteBlocked(true);
      }
      throw caught;
    }
  }, [endpoint, onScenesChange, versionId]);

  const refreshWithNotice = useCallback(() => {
    if (busyRef.current) { refreshQueued.current = true; return; }
    void refresh().then(() => { if (!writeBlockedRef.current) setError(null); })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "同步失败"));
  }, [refresh]);
  useEffect(() => {
    const sequence = readSequence;
    refreshWithNotice();
    return () => { sequence.current++; };
  }, [refreshWithNotice]);
  useVisibleEventSource(versionId ? `${BASE_PATH}/api/script/${productionId}/stream?v=${encodeURIComponent(versionId)}` : null, {
    onReopen: refreshWithNotice,
    listeners: { markers: refreshWithNotice },
  });

  const mutate = async (method: string, body: Record<string, unknown>, markerId?: string) => {
    if (busyRef.current) throw new Error("请等待当前操作完成");
    if (writeBlockedRef.current) throw new Error("请先重试同步，确认当前章节和段落后再操作");
    busyRef.current = true;
    readSequence.current++;
    setBusy(true);
    setError(null);
    try {
      await trackWrite((async () => {
        const response = await fetch(markerId ? `${endpoint}/${markerId}` : endpoint, {
          method, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(versionId ? { versionId } : {}), ...body }),
        });
        const data = await response.json().catch(() => ({}));
        if (method === "DELETE" && ((response.status === 300 && data.plan?.status === "choice") ||
            (response.status === 409 && data.plan?.status === "blocked"))) {
          setDeleteDialog({ plan: data.plan });
          return;
        }
        if (!response.ok || response.status === 202 || data.status === "updating") {
          throw new Error(data.error ?? "操作未完成，请同步后重试");
        }
        if (!Array.isArray(data.scenes)) throw new Error("服务端未返回章节和段落，请同步后确认结果");
        readSequence.current++;
        onScenesChange(data.scenes);
        setDeleteDialog(null);
      })());
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "操作失败";
      setError(message);
      if (method === "DELETE" && deleteDialog) setDeleteDialog({ plan: null, message });
      // 请求可能已落库；先释放锁再对账，不把失败请求当作成功。
      busyRef.current = false;
      await refresh().catch(() => setError(`${message}；同步也失败，请重试同步`));
      throw caught;
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (refreshQueued.current) {
        refreshQueued.current = false;
        refreshWithNotice();
      }
    }
  };

  const siblings = (marker: MarkerProjection) => scenes.filter(item => item.kind === marker.kind && item.parentId === marker.parentId);
  const afterId = (marker: MarkerProjection): string | null => {
    const peers = siblings(marker);
    const next = peers[peers.findIndex(item => item.id === marker.id) + 1];
    if (next) return next.id;
    if (marker.kind === "chapter") return null;
    const chapters = scenes.filter(item => item.kind === "chapter");
    return chapters[chapters.findIndex(item => item.id === marker.parentId) + 1]?.id ?? null;
  };

  const dropBefore = (moving: MarkerProjection, target: MarkerProjection, edge: "top" | "bottom") => {
    if (moving.id === openingChapterMarkerId || moving.id === target.id ||
        moving.kind !== target.kind || moving.parentId !== target.parentId) return undefined;
    const beforeId = edge === "top" ? target.id : afterId(target);
    if (beforeId === openingChapterMarkerId || beforeId === moving.id || beforeId === afterId(moving)) return undefined;
    return beforeId;
  };

  const stepBefore = (marker: MarkerProjection, direction: "up" | "down") => {
    if (marker.id === openingChapterMarkerId) return undefined;
    const peers = siblings(marker);
    const index = peers.findIndex(item => item.id === marker.id);
    const target = peers[index + (direction === "up" ? -1 : 1)];
    return target ? dropBefore(marker, target, direction === "up" ? "top" : "bottom") : undefined;
  };

  return {
    busy, writeBlocked, error, deleteDialog, setDeleteDialog, refreshWithNotice, afterId, dropBefore, stepBefore,
    add: (name: string, parentId: string | null, beforeId: string | null) => mutate("POST", {
      name, parentId, ...(beforeId ? { insertBeforeSceneId: beforeId } : {}),
    }),
    remove: (markerId: string, operation?: MarkerDeleteOperation["type"]) => mutate("DELETE", operation ? { operation } : {}, markerId),
    reorder: (markerId: string, beforeMarkerId: string | null) => mutate("PUT", { markerId, beforeMarkerId }),
  };
}
