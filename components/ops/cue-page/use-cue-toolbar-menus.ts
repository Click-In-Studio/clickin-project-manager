"use client";

import { useState, useEffect } from "react";
import { useAnchoredMenu } from "@/components/shell/ProductionTopMenu";
import type { CueJumpTarget } from "./CueJumpOptions";

/**
 * 顶栏的跳转框与三个菜单（激活表 / 跳转 / 设置）的开合，含按工具栏折叠阶段自动收起与外点关闭。
 * 从 CuePage 主函数体原样搬出（#487 C2）。
 */
export function useCueToolbarMenus() {
  const [jumpTarget, setJumpTarget] = useState<CueJumpTarget | null>(null);
  const [jumpValue, setJumpValue] = useState("");

  type CueToolbarMenu = "active" | "jump" | "settings" | null;
  const [openToolbarMenu, setOpenToolbarMenu] = useState<CueToolbarMenu>(null);
  const activeMenuPosition = useAnchoredMenu<HTMLButtonElement>(
    openToolbarMenu === "active",
    "bottom",
  );
  const settingsMenuPosition = useAnchoredMenu<HTMLButtonElement>(
    openToolbarMenu === "settings",
    "bottom",
  );
  const jumpMenuPosition = useAnchoredMenu<HTMLButtonElement>(openToolbarMenu === "jump", "bottom");
  const toggleToolbarMenu = (menu: Exclude<CueToolbarMenu, null>) => {
    setOpenToolbarMenu((current) => current === menu ? null : menu);
  };
  const finishToolbarAction = () => {
    setOpenToolbarMenu(null);
  };
  const selectJumpTarget = (target: CueJumpTarget) => {
    setJumpTarget((current) => current === target ? null : target);
    setJumpValue("");
    finishToolbarAction();
  };

  useEffect(() => {
    if (!openToolbarMenu) return;
    const dismissOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const panel = target.closest<HTMLElement>("[data-cue-toolbar-menu-panel]");
      const trigger = target.closest<HTMLElement>("[data-cue-toolbar-menu-trigger]");
      const triggerMenu = trigger?.dataset.cueToolbarMenuTrigger;
      if (panel?.dataset.cueToolbarMenuPanel === openToolbarMenu
        || triggerMenu === openToolbarMenu) return;
      setOpenToolbarMenu(null);
    };
    document.addEventListener("mousedown", dismissOnOutsideMouseDown);
    return () => document.removeEventListener("mousedown", dismissOnOutsideMouseDown);
  }, [openToolbarMenu]);

  return {
    jumpTarget, setJumpTarget, jumpValue, setJumpValue,
    openToolbarMenu,
    activeMenuPosition, settingsMenuPosition, jumpMenuPosition, toggleToolbarMenu, finishToolbarAction, selectJumpTarget,
  };
}
