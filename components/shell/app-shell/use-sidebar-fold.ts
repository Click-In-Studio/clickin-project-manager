"use client";

import { useState, useEffect, useLayoutEffect } from "react";

const PRODUCTION_SIDEBAR_TRANSITION_MS = 150;
// Below this width the full production sidebar no longer fits the script layout.
const SCRIPT_SIDEBAR_FOLD_THRESHOLD_PX = 1496;

/**
 * 项目侧栏折叠：剧本页按视口宽度自动折（窄屏时以浮层展开），其余页面手动折；
 * 内容折叠比外壳晚一拍，等过渡动画走完。
 * 从 AppShell 主函数体原样搬出（#487 A2）。
 */
export function useSidebarFold({ isScriptPage }: { isScriptPage: boolean }) {
  const [scriptProductionSidebarAutoFolded, setScriptProductionSidebarAutoFolded] = useState(false);
  const [scriptProductionSidebarManuallyFolded, setScriptProductionSidebarManuallyFolded] = useState(false);
  // v3：非剧本类页面的全局侧栏折叠（原型 sidebarControls toggle）
  const [generalSidebarFolded, setGeneralSidebarFolded] = useState(false);
  const [scriptProductionSidebarOverlayOpen, setScriptProductionSidebarOverlayOpen] = useState(false);
  const [scriptProductionSidebarContentFolded, setScriptProductionSidebarContentFolded] = useState(false);

  useLayoutEffect(() => {
    if (!isScriptPage) {
      setScriptProductionSidebarAutoFolded(false);
      setScriptProductionSidebarManuallyFolded(false);
      setScriptProductionSidebarOverlayOpen(false);
      setScriptProductionSidebarContentFolded(false);
      return;
    }

    const foldQuery = window.matchMedia(`(max-width: ${SCRIPT_SIDEBAR_FOLD_THRESHOLD_PX - 1}px)`);
    const hiddenQuery = window.matchMedia("(max-width: 1023px)");
    const syncSidebarState = () => {
      const autoFolded = foldQuery.matches;
      setScriptProductionSidebarAutoFolded(autoFolded);
      if (!autoFolded || hiddenQuery.matches) setScriptProductionSidebarOverlayOpen(false);
    };
    syncSidebarState();
    foldQuery.addEventListener("change", syncSidebarState);
    hiddenQuery.addEventListener("change", syncSidebarState);
    return () => {
      foldQuery.removeEventListener("change", syncSidebarState);
      hiddenQuery.removeEventListener("change", syncSidebarState);
    };
  }, [isScriptPage]);

  const productionSidebarOverlayOpen = isScriptPage
    && scriptProductionSidebarAutoFolded
    && scriptProductionSidebarOverlayOpen;
  const productionSidebarFolded = isScriptPage
    ? (scriptProductionSidebarAutoFolded
        ? !productionSidebarOverlayOpen
        : scriptProductionSidebarManuallyFolded)
    : generalSidebarFolded;
  const productionSidebarContentFolded = isScriptPage ? scriptProductionSidebarContentFolded : generalSidebarFolded;
  useEffect(() => {
    if (!isScriptPage) return;
    const timer = window.setTimeout(
      () => setScriptProductionSidebarContentFolded(productionSidebarFolded),
      PRODUCTION_SIDEBAR_TRANSITION_MS + 20,
    );
    return () => window.clearTimeout(timer);
  }, [isScriptPage, productionSidebarFolded]);

  const toggleScriptProductionSidebar = () => {
    if (scriptProductionSidebarAutoFolded) {
      setScriptProductionSidebarOverlayOpen((open) => !open);
      return;
    }
    setScriptProductionSidebarManuallyFolded((folded) => !folded);
  };

  return {
    generalSidebarFolded,
    setGeneralSidebarFolded,
    productionSidebarOverlayOpen,
    productionSidebarFolded,
    productionSidebarContentFolded,
    toggleScriptProductionSidebar,
  };
}
