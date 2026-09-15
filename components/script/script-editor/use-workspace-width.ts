"use client";

import { useState, useRef, useCallback } from "react";

/** 工作区可用宽度与左侧项目栏占位（ResizeObserver 挂在 #workspace-scroll）。从 ScriptEditor 主函数体原样搬出（#487 S4）。 */
export function useWorkspaceWidth() {
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [productionSidebarReservedWidth, setProductionSidebarReservedWidth] = useState(0);
  const workspaceMeasureRoRef = useRef<ResizeObserver | null>(null);
  const setWorkspaceMeasureRef = useCallback((el: HTMLDivElement | null) => {
    workspaceMeasureRoRef.current?.disconnect();
    workspaceMeasureRoRef.current = null;
    if (!el) return;
    const workspaceScrollEl = el.closest<HTMLElement>("#workspace-scroll") ?? el;
    const measure = () => {
      setWorkspaceWidth(workspaceScrollEl.clientWidth);
      setProductionSidebarReservedWidth(Math.max(0, workspaceScrollEl.getBoundingClientRect().left));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(workspaceScrollEl);
    workspaceMeasureRoRef.current = ro;
  }, []);

  return { workspaceWidth, productionSidebarReservedWidth, setWorkspaceMeasureRef };
}
