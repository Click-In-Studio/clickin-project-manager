"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { buildOrderedTocScenes } from "@/lib/script/script-scene-details";
import type { Block, Scene } from "@/lib/script/script-types";
import { SCRIPT_TOC_CENTER_EVENT, SCRIPT_TOC_RAIL_NUMBER_SLOT_REM, SCRIPT_TOC_RAIL_LABEL_GAP_REM, SCRIPT_TOC_RAIL_SUBSCENE_INDENT_REM } from "./constants";

export default function TableOfContents({
  scenes,
  blocks,
  onScrollToScene,
  activeSceneId,
  placement = "inline",
  chapterNumberSlotWidthPx,
  sceneNumberSlotWidthPx,
}: {
  scenes: Scene[];
  blocks: Block[];
  onScrollToScene?: (sceneId: string) => void;
  activeSceneId?: string | null;
  placement?: "inline" | "rail" | "rail-compact";
  chapterNumberSlotWidthPx?: number;
  sceneNumberSlotWidthPx?: number;
}) {
  const isRailPlacement = placement !== "inline";
  const isCompactRail = placement === "rail-compact";
  const orderedScenes = useMemo(() => buildOrderedTocScenes(scenes, blocks), [scenes, blocks]);
  const navRef = useRef<HTMLElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const didInitialCenterRef = useRef(false);
  const centerFrameRef = useRef<number | null>(null);
  const centerActiveItem = useCallback(() => {
    const nav = navRef.current;
    const item = activeItemRef.current;
    if (!nav || !item) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    nav.scrollTop += itemRect.top + itemRect.height / 2 - (navRect.top + nav.clientHeight / 2);
  }, []);
  const centerActiveItemSoon = useCallback(() => {
    if (centerFrameRef.current !== null) cancelAnimationFrame(centerFrameRef.current);
    centerFrameRef.current = requestAnimationFrame(() => {
      centerFrameRef.current = null;
      centerActiveItem();
    });
  }, [centerActiveItem]);

  useEffect(() => {
    if (!isRailPlacement || !activeSceneId || didInitialCenterRef.current) return;
    didInitialCenterRef.current = true;
    centerActiveItem();
  }, [activeSceneId, centerActiveItem, isRailPlacement]);

  useEffect(() => {
    if (!isRailPlacement) return;
    window.addEventListener(SCRIPT_TOC_CENTER_EVENT, centerActiveItemSoon);
    return () => {
      window.removeEventListener(SCRIPT_TOC_CENTER_EVENT, centerActiveItemSoon);
      if (centerFrameRef.current !== null) cancelAnimationFrame(centerFrameRef.current);
    };
  }, [centerActiveItemSoon, isRailPlacement]);

  if (orderedScenes.length === 0) return null;

  const scrollTo = (sceneId: string) => {
    if (onScrollToScene) { onScrollToScene(sceneId); return; }
    document.getElementById(`scene-block-${sceneId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const wrapClass = isRailPlacement
    ? `panel-scrollbar-area flex h-full min-w-0 w-full flex-col overflow-hidden rounded-xl border border-transparent bg-transparent py-3 ${isCompactRail ? "px-1" : "px-3"}`
    : "px-8 pt-6 pb-5 border-b border-zinc-100";
  const navClass = isRailPlacement
    ? "panel-scrollbar flex min-h-0 min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden overscroll-contain pr-1"
    : "flex flex-col gap-0.5";

  return (
    <div className={wrapClass}>
      <p className={`mb-3 text-[10px] font-bold tracking-widest text-zinc-300 uppercase ${isCompactRail ? "text-center" : ""}`}>目录</p>
      <nav ref={navRef} className={navClass}>
        {orderedScenes.map((scene) => {
          const isSubScene = scene.parentId !== null;
          const isActive = scene.id === activeSceneId;
          const numberSlotWidthPx = isSubScene ? sceneNumberSlotWidthPx : chapterNumberSlotWidthPx;
          return (
            <button
              key={scene.id}
              ref={isActive ? activeItemRef : undefined}
              title={scene.name ? `${scene.number || "—"} ${scene.name}` : (scene.number || "—")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.currentTarget.blur();
                scrollTo(scene.id);
              }}
              style={isCompactRail ? undefined : {
                columnGap: `${SCRIPT_TOC_RAIL_LABEL_GAP_REM}rem`,
                ...(isRailPlacement && isSubScene ? { paddingLeft: `calc(0.5rem + ${SCRIPT_TOC_RAIL_SUBSCENE_INDENT_REM}rem)` } : {}),
              }}
              className={`flex w-full min-w-0 shrink-0 items-baseline overflow-hidden rounded-lg px-2 py-1 text-left transition-colors hover:bg-zinc-50 group ${
                isCompactRail ? "justify-center gap-0" : `${!isRailPlacement && isSubScene ? "pl-6" : ""}`
              } ${
                isActive ? "bg-white hover:bg-white" : ""
              }`}
            >
              <span
                style={isCompactRail
                  ? undefined
                  : { minWidth: numberSlotWidthPx ? `${numberSlotWidthPx}px` : `${SCRIPT_TOC_RAIL_NUMBER_SLOT_REM}rem` }}
                className={`${isCompactRail ? "min-w-0" : "inline-block shrink-0 text-right"} text-xs tracking-wider ${
                isActive
                  ? "font-bold text-[#637ca1]"
                  : isSubScene
                    ? "font-medium text-zinc-300 group-hover:text-zinc-400"
                    : "font-bold text-zinc-400 group-hover:text-zinc-600"
                }`}
              >
                {scene.number || "—"}
              </span>
              {!isCompactRail && (
                <span className={`min-w-0 flex-1 truncate ${
                  isActive
                    ? `${isSubScene ? "text-xs" : "text-sm"} font-semibold text-zinc-700`
                    : isSubScene
                      ? "text-xs text-zinc-300 group-hover:text-zinc-500"
                      : "text-sm font-medium text-zinc-400 group-hover:text-zinc-700"
                }`}>
                  {scene.name || <span className="italic text-zinc-200">未命名</span>}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
