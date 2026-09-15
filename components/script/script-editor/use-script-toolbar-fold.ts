"use client";

import { useState, useRef, useEffect, useCallback, type MutableRefObject } from "react";
import { PRODUCTION_TOP_MENU_SLOT_ID, PRODUCTION_TOOLBAR_STAGE, type ProductionToolbarStage } from "@/components/shell/ProductionTopMenu";
import type { ScriptToolbarOpenMenu, ScriptToolbarMode } from "./ScriptToolbarMenuController";
import { TOOLBAR_FOLD_HYSTERESIS_PX } from "./constants";

/**
 * 剧本工具栏自己的三级折叠（full → short → compact）：按 scrollWidth 与 clientWidth 量，
 * 带回滞；挂在项目顶栏槽位里时交给顶栏阶段不自量。版本 / 锁定态 / 权限一变就重量。
 * 从 ScriptEditor 主函数体原样搬出（#487 S4）。
 */
export function useScriptToolbarFold({
  toolbarStage, navigatingAwayRef, toolbarOpenMenuRef, closeToolbarMenu,
  activeVersionId, isLockedMode, canEditMetadata,
}: {
  toolbarStage: ProductionToolbarStage;
  navigatingAwayRef: MutableRefObject<boolean>;
  toolbarOpenMenuRef: MutableRefObject<ScriptToolbarOpenMenu>;
  closeToolbarMenu: () => void;
  activeVersionId: string | null;
  isLockedMode: boolean;
  canEditMetadata: boolean;
}) {
  const [toolbarMode, setToolbarMode] = useState<ScriptToolbarMode>("full");
  const [toolbarMeasureTick, setToolbarMeasureTick] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const fullToolbarWidthRef = useRef(0);
  const shortToolbarWidthRef = useRef(0);
  const toolbarCompact = toolbarStage >= PRODUCTION_TOOLBAR_STAGE.primaryStored || toolbarMode === "compact";
  const toolbarShort = !toolbarCompact && (toolbarStage >= PRODUCTION_TOOLBAR_STAGE.primaryShort || toolbarMode === "short");
  const presenceFolded = toolbarStage >= PRODUCTION_TOOLBAR_STAGE.lowPriorityStored;
  const setToolbarElement = useCallback((el: HTMLDivElement | null) => {
    toolbarRef.current = el;
    if (el) setToolbarMeasureTick(tick => tick + 1);
  }, []);
  const resetToolbarMeasurement = useCallback((closeMenus = true) => {
    fullToolbarWidthRef.current = 0;
    shortToolbarWidthRef.current = 0;
    setToolbarMode("full");
    if (closeMenus) {
      closeToolbarMenu();
    }
  }, [closeToolbarMenu]);

  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const productionTopMenuSlot = el.closest(`#${PRODUCTION_TOP_MENU_SLOT_ID}`);
    if (productionTopMenuSlot) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      if (navigatingAwayRef.current || toolbarOpenMenuRef.current) return;
      const available = el.clientWidth;
      const required = el.scrollWidth;
      if (toolbarMode === "full") {
        fullToolbarWidthRef.current = required;
        if (required > available + 1) {
          setToolbarMode("short");
        }
        return;
      }
      if (toolbarMode === "short") {
        shortToolbarWidthRef.current = required;
        if (required > available + 1) {
          setToolbarMode("compact");
          return;
        }
        if (fullToolbarWidthRef.current > 0 && available >= fullToolbarWidthRef.current + TOOLBAR_FOLD_HYSTERESIS_PX) {
          setToolbarMode("full");
        }
        return;
      }
      if (fullToolbarWidthRef.current > 0 && available >= fullToolbarWidthRef.current + TOOLBAR_FOLD_HYSTERESIS_PX) {
        setToolbarMode("full");
        return;
      }
      if (shortToolbarWidthRef.current > 0 && available >= shortToolbarWidthRef.current + TOOLBAR_FOLD_HYSTERESIS_PX) {
        setToolbarMode("short");
      }
    };
    const scheduleMeasure = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    scheduleMeasure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [toolbarMode, toolbarMeasureTick, navigatingAwayRef, toolbarOpenMenuRef]);

  useEffect(() => {
    resetToolbarMeasurement();
  }, [activeVersionId, isLockedMode, canEditMetadata, resetToolbarMeasurement]);

  return { toolbarMode, toolbarCompact, toolbarShort, presenceFolded, setToolbarElement, setToolbarMeasureTick, resetToolbarMeasurement };
}
