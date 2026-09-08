"use client";
import { useState, useEffect, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { writeFetch, refreshNow } from "@/lib/write-refresh";

type PermEntry = { granted: boolean; selfConfirmable: boolean };

/**
 * Fetches the current user's selfConfirmable permissions for a production,
 * optionally filtered to a scope set.
 *
 * Returns:
 *   pending  — null while loading; empty array means nothing to confirm
 *   confirming — true while POST is in-flight
 *   confirm(perms) — writes grants for the given permission keys
 *
 * confirm 成功后必须失效 router cache（refreshNow）：各页面的写面开关（characters 的
 * CharacterPerms、dramaturgy 的 SceneFieldPerms、script 的 canEditText 等）都是
 * **服务端组件渲染时**查库算出来的。只更新 pending 不刷新，用户会看到「弹窗一键
 * 激活 → 弹窗消失 → 页面仍然只读」，必须手动刷新才生效。
 */
export function usePendingPermissions(
  productionId: string,
  scope: ReadonlySet<string>,
) {
  const [pending, setPending] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE_PATH}/api/production/${productionId}/my-permissions`, {
      credentials: "include",
    })
      .then(r => r.json() as Promise<{ permissions: Record<string, PermEntry> }>)
      .then(data => {
        if (cancelled) return;
        const found = Object.entries(data.permissions)
          .filter(([k, v]) => v.selfConfirmable && scope.has(k))
          .map(([k]) => k);
        setPending(found);
      })
      .catch(() => {
        if (!cancelled) setPending([]);
      });
    return () => { cancelled = true; };
  }, [productionId]); // scope is a module-level constant — stable across renders

  const confirm = useCallback(
    async (perms: string[]) => {
      if (perms.length === 0) return;
      setConfirming(true);
      try {
        const res = await writeFetch(`${BASE_PATH}/api/production/${productionId}/my-permissions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ permissions: perms }),
        });
        if (!res.ok) return;
        setPending(prev => prev?.filter(p => !perms.includes(p)) ?? []);
        // 让服务端组件用新落的 grant 行重算写面开关。
        // 用 refreshNow 而非 router.refresh：writeFetch 已排了一次去抖刷新，
        // 这里既要立即生效、又不能刷两趟（#416）。
        refreshNow();
      } finally {
        setConfirming(false);
      }
    },
    [productionId],
  );

  return { pending, confirming, confirm };
}
