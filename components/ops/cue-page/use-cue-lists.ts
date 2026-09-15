"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { CueList } from "@/lib/ops/cue-list-types";
import type { Cue } from "@/lib/ops/cue-types";
import { readCookie, writeCookie } from "./cookies";
import type { CueViewState } from "./types";

export type AccessModal =
    | { listId: string; listName: string; status: "loading" }
    | { listId: string; listName: string; status: "can_self_confirm"; selfConfirmLevel: "edit" | "manage" }
    | { listId: string; listName: string; status: "needs_approval" };

/**
 * cue 表的可见 / 激活 / 本地权限状态 + 视图偏好 cookie + 激活时的访问确认弹窗。
 * 从 CuePage 主函数体原样搬出（#487 C2），签名即原 state 集合。
 */
export function useCueLists({
  productionId, cueLists, editableListIds, manageListIds, myUserId,
}: {
  productionId: string;
  cueLists: CueList[];
  editableListIds: string[];
  manageListIds: string[];
  myUserId: string;
}) {
  const [visibleListIds, setVisibleListIds] = useState<Set<string>>(
    () => new Set(cueLists.slice(0, 3).map(cl => cl.id))
  );
  const [activeListId, setActiveListId] = useState<string | null>(
    editableListIds[0] ?? cueLists[0]?.id ?? null
  );
  const toggleListVisibility = (listId: string) => {
    setVisibleListIds((current) => {
      if (listId === activeListId) return current;
      const next = new Set(current);
      if (next.has(listId)) next.delete(listId); else next.add(listId);
      return next;
    });
  };
  // Phase 4: localEditableIds starts from server-computed editableListIds and can be
  // extended when the user self-confirms access to additional lists.
  const [localEditableIds, setLocalEditableIds] = useState<Set<string>>(
    () => new Set(editableListIds),
  );
  const [localManageIds, setLocalManageIds] = useState<Set<string>>(
    // creator always has implicit manage permission regardless of production_member_grant state
    () => new Set([...manageListIds, ...cueLists.filter(cl => cl.createdBy === myUserId).map(cl => cl.id)]),
  );
  const [shareModalListId, setShareModalListId] = useState<string | null>(null);
  // Phase 4: Access modal state — shown when user activates a list they don't yet have edit access to.
  const [accessModal, setAccessModal] = useState<AccessModal | null>(null);
  const [accessModalConfirming, setAccessModalConfirming] = useState(false);

  // ── Cookie: restore cue view state once on mount ──────────────────────────
  const cueStateRestoredRef = useRef(false);
  useEffect(() => {
    if (cueStateRestoredRef.current) return;
    cueStateRestoredRef.current = true;
    const raw = readCookie(`cue_view_${productionId}`);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as CueViewState;
      const validIds = (saved.visibleIds ?? []).filter(id => cueLists.some(cl => cl.id === id));
      if (validIds.length > 0) setVisibleListIds(new Set(validIds));
      if (saved.activeId && cueLists.some(cl => cl.id === saved.activeId))
        setActiveListId(saved.activeId);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cookie: save cue view state on change ────────────────────────────────
  useEffect(() => {
    if (!cueStateRestoredRef.current) return;
    writeCookie(`cue_view_${productionId}`, JSON.stringify({ visibleIds: [...visibleListIds], activeId: activeListId } satisfies CueViewState));
  }, [visibleListIds, activeListId, productionId]);

  const visibleListIdsRef = useRef(visibleListIds);
  useEffect(() => { visibleListIdsRef.current = visibleListIds; }, [visibleListIds]);
  const activeListIdRef = useRef(activeListId);
  useEffect(() => { activeListIdRef.current = activeListId; }, [activeListId]);

  // Active list is always visible even if toggled off
  const activeCueList = useMemo(
    () => cueLists.find((list) => list.id === activeListId) ?? null,
    [cueLists, activeListId],
  );
  const canShareActive = activeListId !== null && localManageIds.has(activeListId);
  const visibleLists = useMemo(
    () => cueLists.filter(cl => visibleListIds.has(cl.id) || cl.id === activeListId),
    [cueLists, visibleListIds, activeListId],
  );
  const listColorIndex = useMemo(() => {
    const m = new Map<string, number>();
    cueLists.forEach((cl, i) => m.set(cl.id, i));
    return m;
  }, [cueLists]);

  const canEditActive = localEditableIds.has(activeListId ?? "");
  // Editing any cue requires an active list — prevents accidental edits with no context
  const canEditCue = useCallback((cue: Cue) =>
    cue.cueListId === activeListId && localEditableIds.has(cue.cueListId),
  [activeListId, localEditableIds]);

  // Phase 4: activate a cue list, showing access modal if not yet granted
  const handleActivateList = useCallback(async (listId: string | null) => {
    if (!listId || localEditableIds.has(listId)) {
      setActiveListId(listId);
      return;
    }
    const list = cueLists.find(cl => cl.id === listId);
    if (!list) { setActiveListId(listId); return; }
    setActiveListId(listId);
    setAccessModal({ listId, listName: list.name, status: "loading" });
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/access`,
        { credentials: "include" },
      );
      if (!res.ok) { setAccessModal(null); return; }
      const data = await res.json() as
        | { canAccess: true }
        | { canAccess: false; canSelfConfirm: true; selfConfirmLevel: "edit" | "manage" }
        | { canAccess: false; canSelfConfirm: false };
      if (data.canAccess) {
        setLocalEditableIds(prev => new Set([...prev, listId]));
        if ((data as { level?: string }).level === "manage") {
          setLocalManageIds(prev => new Set([...prev, listId]));
        }
        setAccessModal(null);
      } else if (data.canSelfConfirm) {
        setAccessModal({ listId, listName: list.name, status: "can_self_confirm", selfConfirmLevel: data.selfConfirmLevel });
      } else {
        setAccessModal({ listId, listName: list.name, status: "needs_approval" });
      }
    } catch {
      setAccessModal(null);
    }
  }, [cueLists, localEditableIds, productionId]);

  return {
    visibleListIds, setVisibleListIds, activeListId, setActiveListId, toggleListVisibility,
    localEditableIds, setLocalEditableIds, localManageIds, setLocalManageIds,
    shareModalListId, setShareModalListId,
    accessModal, setAccessModal, accessModalConfirming, setAccessModalConfirming,
    visibleListIdsRef, activeListIdRef,
    activeCueList, canShareActive, visibleLists, listColorIndex, canEditActive, canEditCue,
    handleActivateList,
  };
}
