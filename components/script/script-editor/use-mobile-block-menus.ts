"use client";

import { useState, useEffect, useCallback } from "react";

/** 移动端的块菜单 / 插入菜单 / 批量操作三态 + 外点关闭。从 ScriptEditor 主函数体原样搬出（#487 S4）。 */
export function useMobileBlockMenus() {
  const [mobileBlockMenuBlockId, setMobileBlockMenuBlockId] = useState<string | null>(null);
  const [mobileInsertMenuOpen, setMobileInsertMenuOpen] = useState(false);
  const [mobileBatchAction, setMobileBatchAction] = useState<"type" | "lyric" | null>(null);
  const closeMobileBlockMenu = useCallback(() => {
    setMobileBatchAction(null);
    setMobileInsertMenuOpen(false);
    setMobileBlockMenuBlockId(null);
  }, []);
  useEffect(() => {
    if (mobileBlockMenuBlockId === null) return;
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest("[data-script-mobile-block-menu='true']") ||
        target.closest("[data-script-block-bar='true']:not([data-script-marker-bar='true'])")
      ) return;
      event.preventDefault();
      event.stopPropagation();
      closeMobileBlockMenu();
    };
    document.addEventListener("click", handleOutsideClick, true);
    return () => document.removeEventListener("click", handleOutsideClick, true);
  }, [closeMobileBlockMenu, mobileBlockMenuBlockId]);

  return {
    mobileBlockMenuBlockId, setMobileBlockMenuBlockId,
    mobileInsertMenuOpen, setMobileInsertMenuOpen,
    mobileBatchAction, setMobileBatchAction,
    closeMobileBlockMenu,
  };
}
