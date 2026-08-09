"use client";
import { useState, useEffect, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";

type PermEntry = { granted: boolean; selfConfirmable: boolean };

/**
 * Fetches the current user's selfConfirmable permissions for a production,
 * optionally filtered to a scope set.
 *
 * Returns:
 *   pending  — null while loading; empty array means nothing to confirm
 *   confirming — true while POST is in-flight
 *   confirm(perms) — writes grants for the given permission keys
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
        await fetch(`${BASE_PATH}/api/production/${productionId}/my-permissions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ permissions: perms }),
        });
        setPending(prev => prev?.filter(p => !perms.includes(p)) ?? []);
      } finally {
        setConfirming(false);
      }
    },
    [productionId],
  );

  return { pending, confirming, confirm };
}
