"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useAnchoredMenu } from "@/components/shell/ProductionTopMenu";

export type ScriptToolbarOpenMenu = "script" | "mode" | "edit" | "display" | "export" | "scene" | "char" | "presence" | null;

export type ScriptToolbarMenuControls = {
  openMenu: ScriptToolbarOpenMenu;
  setOpenMenu: (menu: ScriptToolbarOpenMenu) => void;
  toggleMenu: (menu: Exclude<ScriptToolbarOpenMenu, null>) => void;
  handleCharacterPanelOpenChange: (open: boolean) => void;
  scriptMenuPosition: ReturnType<typeof useAnchoredMenu<HTMLButtonElement>>;
  nestedMenuPosition: ReturnType<typeof useAnchoredMenu<HTMLButtonElement>>;
};

export default function ScriptToolbarMenuController({
  characterCloseBlocked,
  openMenuRef,
  closeMenuRef,
  children,
}: {
  characterCloseBlocked: boolean;
  openMenuRef: React.MutableRefObject<ScriptToolbarOpenMenu>;
  closeMenuRef: React.MutableRefObject<() => void>;
  children: (controls: ScriptToolbarMenuControls) => React.ReactNode;
}) {
  const [openMenu, setOpenMenuState] = useState<ScriptToolbarOpenMenu>(null);
  const scriptMenuPosition = useAnchoredMenu<HTMLButtonElement>(openMenu === "script", "bottom");
  const nestedMenuPosition = useAnchoredMenu<HTMLButtonElement>(
    openMenu !== null && openMenu !== "script",
    "bottom",
    openMenu,
  );
  const setOpenMenu = useCallback((menu: ScriptToolbarOpenMenu) => {
    if (menu && menu !== "script") nestedMenuPosition.anchorRef.current = document.querySelector<HTMLButtonElement>(`[data-script-toolbar-menu-trigger="${menu}"]`);
    openMenuRef.current = menu;
    setOpenMenuState(menu);
  }, [openMenuRef, nestedMenuPosition.anchorRef]);
  const closeMenu = useCallback(() => setOpenMenu(null), [setOpenMenu]);
  const toggleMenu = useCallback((menu: Exclude<ScriptToolbarOpenMenu, null>) => {
    setOpenMenu(openMenuRef.current === menu ? null : menu);
  }, [setOpenMenu, openMenuRef]);
  const handleCharacterPanelOpenChange = useCallback((open: boolean) => {
    if (!open && characterCloseBlocked) return;
    setOpenMenu(open ? "char" : null);
  }, [characterCloseBlocked, setOpenMenu]);

  closeMenuRef.current = closeMenu;

  useEffect(() => {
    if (!openMenu) return;
    const dismissOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const panel = target.closest<HTMLElement>("[data-script-toolbar-menu-panel]");
      const scriptTrigger = target.closest<HTMLElement>("[data-script-toolbar-menu-trigger]");
      const overflowTrigger = target.closest<HTMLElement>("[data-production-overflow-submenu-trigger]");
      const triggerMenu = scriptTrigger?.dataset.scriptToolbarMenuTrigger
        ?? overflowTrigger?.dataset.productionOverflowSubmenuTrigger;
      if (panel?.dataset.scriptToolbarMenuPanel === openMenu || triggerMenu) return;
      if (openMenu === "char") handleCharacterPanelOpenChange(false);
      else closeMenu();
    };
    document.addEventListener("mousedown", dismissOnOutsideMouseDown);
    return () => document.removeEventListener("mousedown", dismissOnOutsideMouseDown);
  }, [closeMenu, handleCharacterPanelOpenChange, openMenu]);

  useEffect(() => () => {
    openMenuRef.current = null;
    if (closeMenuRef.current === closeMenu) closeMenuRef.current = () => {};
  }, [closeMenu, closeMenuRef, openMenuRef]);

  return children({
    openMenu,
    setOpenMenu,
    toggleMenu,
    handleCharacterPanelOpenChange,
    scriptMenuPosition,
    nestedMenuPosition,
  });
}
