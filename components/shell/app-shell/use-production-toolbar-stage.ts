"use client";

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import {
  PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID,
  PRODUCTION_TOP_MENU_SLOT_ID,
  PRODUCTION_TOOLBAR_STAGE,
  type ProductionToolbarStage,
  useAnchoredMenu,
} from "../ProductionTopMenu";
import {
  type ProductionHeaderStage,
  productionHeaderStageForWidth,
  adjacentProductionToolbarStage,
  productionTopbarContentWidth,
} from "./toolbar-stage";

const PRODUCTION_TOOLBAR_UNFOLD_BUFFER_PX = 16;

/**
 * 项目头部 / 顶栏工具栏的折叠阶段：按视口宽度定头部阶段，按顶栏内容是否溢出逐级收纳
 * 工具栏控件，外加溢出菜单与搜索框展开的联动。
 * 从 AppShell 主函数体原样搬出（#487 A2）；换页时的复位原本与抽屉复位同在一个 effect 里，
 * 这里只带走工具栏那三行。
 */
export function useProductionToolbarStage({ pathname }: { pathname: string }) {
  const [productionHeaderStage, setProductionHeaderStage] = useState<ProductionHeaderStage>(0);
  const [productionToolbarStage, setProductionToolbarStage] = useState<ProductionToolbarStage>(0);
  const [productionToolbarHasStoredControls, setProductionToolbarHasStoredControls] = useState(false);
  const [topOverflowOpen, setTopOverflowOpen] = useState(false);
  const [productionSearchPath, setProductionSearchPath] = useState<string | null>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const topOverflowRef = useRef<HTMLDivElement>(null);
  const productionSearchOpenRef = useRef(false);
  const productionToolbarStageRef = useRef<ProductionToolbarStage>(productionToolbarStage);
  const productionToolbarHasStoredControlsRef = useRef(productionToolbarHasStoredControls);
  const productionToolbarRequiredWidthRef = useRef<Partial<Record<ProductionToolbarStage, number>>>({});
  productionToolbarStageRef.current = productionToolbarStage;
  productionToolbarHasStoredControlsRef.current = productionToolbarHasStoredControls;
  const closeTopOverflow = useCallback(() => setTopOverflowOpen(false), []);
  const topOverflowMenu = useAnchoredMenu<HTMLButtonElement>(topOverflowOpen, "bottom");
  const handleProductionSearchOpenChange = useCallback((open: boolean, stored: boolean) => {
    productionSearchOpenRef.current = open;
    if (open && !stored) closeTopOverflow();
    setProductionSearchPath(open && !stored ? pathname : null);
  }, [pathname, closeTopOverflow]);
  const productionToolbarContext = useMemo(() => ({
    stage: productionToolbarStage,
    closeOverflow: closeTopOverflow,
    overflowOpen: topOverflowOpen,
    hasStoredControls: productionToolbarHasStoredControls,
    setHasStoredControls: setProductionToolbarHasStoredControls,
  }), [productionToolbarStage, productionToolbarHasStoredControls, topOverflowOpen, closeTopOverflow]);

  useLayoutEffect(() => {
    const syncHeaderStage = () => setProductionHeaderStage(productionHeaderStageForWidth(window.innerWidth));
    syncHeaderStage();
    window.addEventListener("resize", syncHeaderStage);
    return () => window.removeEventListener("resize", syncHeaderStage);
  }, []);

  const measureProductionToolbar = useCallback(() => {
    const topbar = topbarRef.current;
    if (!topbar) return;
    if (productionSearchOpenRef.current) return;

    const current = productionToolbarStageRef.current;
    if (!topbar.querySelector(`#${PRODUCTION_TOP_MENU_SLOT_ID}`)) return;
    const overflowTarget = topbar.querySelector(`#${PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID}`);
    if (!!overflowTarget?.childElementCount !== productionToolbarHasStoredControlsRef.current) return;

    const overflow = productionTopbarContentWidth(topbar) - topbar.clientWidth;
    if (overflow > 1 && current < PRODUCTION_TOOLBAR_STAGE.lowPriorityStored) {
      productionToolbarRequiredWidthRef.current[current] = topbar.clientWidth + overflow;
      setProductionToolbarStage(adjacentProductionToolbarStage(current, 1));
      return;
    }

    if (current > 0) {
      const previous = adjacentProductionToolbarStage(current, -1);
      const previousRequiredWidth = productionToolbarRequiredWidthRef.current[previous];
      if (previousRequiredWidth && topbar.clientWidth >= previousRequiredWidth + PRODUCTION_TOOLBAR_UNFOLD_BUFFER_PX) {
        setProductionToolbarStage(previous);
      }
    }
  }, []);

  useLayoutEffect(() => {
    measureProductionToolbar();
  }, [productionSearchPath, productionHeaderStage, productionToolbarStage, productionToolbarHasStoredControls, measureProductionToolbar]);

  useEffect(() => {
    const topbar = topbarRef.current;
    if (!topbar) return;
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measureProductionToolbar();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    resizeObserver.observe(topbar);
    mutationObserver.observe(topbar, { childList: true, characterData: true, subtree: true });
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [measureProductionToolbar]);

  useLayoutEffect(() => {
    productionToolbarRequiredWidthRef.current = {};
    productionToolbarStageRef.current = 0;
    setProductionToolbarStage(0);
  }, [pathname]);

  useLayoutEffect(() => {
    closeTopOverflow();
  }, [productionToolbarStage, productionToolbarHasStoredControls, closeTopOverflow]);

  useEffect(() => {
    setProductionSearchPath(null);
    productionSearchOpenRef.current = false;
    setTopOverflowOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!topOverflowOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (topOverflowRef.current?.contains(target as Node)) return;
      if (target instanceof Element && target.closest("[data-production-overflow-menu-child]")) return;
      closeTopOverflow();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [topOverflowOpen, closeTopOverflow]);

  return {
    productionHeaderStage,
    productionToolbarStage,
    productionToolbarHasStoredControls,
    topbarRef,
    topOverflowRef,
    topOverflowOpen,
    setTopOverflowOpen,
    topOverflowMenu,
    productionSearchPath,
    handleProductionSearchOpenChange,
    productionToolbarContext,
  };
}
