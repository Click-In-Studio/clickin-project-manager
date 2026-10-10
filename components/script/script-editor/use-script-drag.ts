"use client";

import { useCallback, useRef, useState, useMemo } from "react";
import { sameDragTarget, type DragTarget } from "@/lib/script/script-drag-target";

type DragSession = { ids: string[]; target: DragTarget | null; invalidReason: string | null };

export function useScriptDrag() {
  const current = useRef<DragSession | null>(null);
  const [view, setView] = useState<{ dragging: boolean; target: DragTarget | null }>({ dragging: false, target: null });
  const read = useCallback(() => current.current, []);
  const begin = useCallback((ids: string[]) => {
    current.current = { ids, target: null, invalidReason: null };
    setView({ dragging: true, target: null });
  }, []);
  const setTarget = useCallback((target: DragTarget | null) => {
    if (current.current) current.current = { ...current.current, target };
    setView(previous => sameDragTarget(previous.target, target) ? previous : { ...previous, target });
  }, []);
  const reject = useCallback((invalidReason: string | null) => {
    if (current.current) current.current = { ...current.current, invalidReason };
  }, []);
  const end = useCallback(() => {
    const session = current.current;
    current.current = null;
    setView({ dragging: false, target: null });
    return session;
  }, []);
  const drag = useMemo(() => ({ read, begin, setTarget, reject, end }), [read, begin, setTarget, reject, end]);
  return { drag, snapshot: view };
}
