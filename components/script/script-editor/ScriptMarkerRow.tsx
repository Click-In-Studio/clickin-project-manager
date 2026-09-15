"use client";

import React, { type DragEvent } from "react";
import type { DragTarget } from "@/lib/script/script-drag-target";
import type { Scene } from "@/lib/script/script-types";
import RehearsalMarkInput from "./RehearsalMarkInput";
import SceneHeader from "./SceneHeader";
import { LINE_INDEX_GUTTER_OFFSET_REM, REHEARSAL_MARKER_ROW_BASE_HEIGHT_REM, REHEARSAL_MARKER_ROW_HEIGHT_SCALE, REHEARSAL_MARKER_ROW_MIN_HEIGHT_PX, REHEARSAL_MARKER_FLOAT_LEFT_OFFSET_REM, MARKER_CONTROL_DELETE_LEFT_PX, MARKER_CONTROL_BAR_LEFT_PX, MARKER_CONTROL_TRIANGLE_LEFT_PX, MARKER_CONTROL_TRIANGLE_TOP_OFFSET_PX, MARKER_DIVIDER_RIGHT_MARGIN } from "./constants";

export type ScriptMarkerNode =
  | { kind: "chapter"; id: string; scene: Scene }
  | { kind: "scene"; id: string; scene: Scene }
  | { kind: "rehearsal"; id: string; mark: string };

export default function ScriptMarkerRow({
  node,
  canEdit,
  isSelected,
  isDeleteConfirmHighlighted,
  isDeleteConfirmationOpen,
  isMobileMenuOpen = false,
  isReorderLocked,
  isScriptDragging,
  dragTarget,
  onRemove,
  onRequestDelete,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onSelect,
  canAddChapterScene,
  canAddRehearsal,
  onAddChapterBefore,
  onAddSceneBefore,
  onAddRehearsalBefore,
  onConvertToChapter,
  onConvertToScene,
  onOpenSceneDetail,
  onDeleteConfirmChange,
  onSceneNameChange,
  onMobileMenuOpen,
  deleteCount = 1,
  lineIndexWidth,
  isRecentlyMoved = false,
  isTocHighlighted = false,
  reserveRehearsalGap = false,
}: {
  node: ScriptMarkerNode;
  canEdit: boolean;
  isSelected: boolean;
  isDeleteConfirmHighlighted: boolean;
  isDeleteConfirmationOpen: boolean;
  isMobileMenuOpen?: boolean;
  isReorderLocked: boolean;
  isScriptDragging: boolean;
  dragTarget?: DragTarget | null;
  onRemove: () => void;
  onRequestDelete: () => boolean;
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onSelect: (e: React.MouseEvent<HTMLElement>) => void;
  canAddChapterScene: boolean;
  canAddRehearsal: boolean;
  onAddChapterBefore: () => void;
  onAddSceneBefore: () => void;
  onAddRehearsalBefore: () => void;
  onConvertToChapter?: () => void;
  onConvertToScene?: () => void;
  onOpenSceneDetail?: () => void;
  onDeleteConfirmChange?: (confirming: boolean) => void;
  onSceneNameChange?: (id: string, name: string) => void;
  onMobileMenuOpen?: () => void;
  deleteCount?: number;
  lineIndexWidth?: string;
  isRecentlyMoved?: boolean;
  isTocHighlighted?: boolean;
  reserveRehearsalGap?: boolean;
}) {
  const isRehearsal = node.kind === "rehearsal";
  const markerRootStyle: React.CSSProperties | undefined = lineIndexWidth
    ? { paddingLeft: `calc(${lineIndexWidth} + ${LINE_INDEX_GUTTER_OFFSET_REM}rem)`,
        marginRight: `${MARKER_DIVIDER_RIGHT_MARGIN}rem` }
    : undefined;
  const rehearsalMarkerStyle: React.CSSProperties | undefined = isRehearsal
    ? { height: reserveRehearsalGap ? "1.25rem" : `max(${REHEARSAL_MARKER_ROW_MIN_HEIGHT_PX}px, ${REHEARSAL_MARKER_ROW_BASE_HEIGHT_REM * REHEARSAL_MARKER_ROW_HEIGHT_SCALE}rem)` }
    : undefined;
  const rehearsalFloatStyle: React.CSSProperties | undefined = isRehearsal
    ? { left: `calc(1.5rem + ${REHEARSAL_MARKER_FLOAT_LEFT_OFFSET_REM}rem)` }
    : undefined;
  const title = isRehearsal
    ? `排练记号 ${node.mark}`
    : [node.scene.number, node.scene.name].filter(Boolean).join(" ");
  const deleteConfirmText = deleteCount > 1
    ? `确认删除所选 ${deleteCount} 行？`
    : node.kind === "chapter"
      ? "确认删除此章节标记？"
      : node.kind === "scene"
        ? "确认删除此段落标记？"
        : "确认删除此排练记号？";
  const markerMovedGlowClass = isRecentlyMoved && !isRehearsal ? "script-block-moved-glow" : "";
  const markerTocGlowClass = !isRehearsal && !isRecentlyMoved && isTocHighlighted ? "script-toc-marker-glow" : "";
  const isDeleteHighlighted = isDeleteConfirmationOpen || isDeleteConfirmHighlighted;
  const markerGlowEndColor = !isRehearsal && isTocHighlighted
    ? isDeleteHighlighted ? "#fee2e2" : isSelected ? "#eef3fa" : "#ffffff"
    : undefined;
  const convertToChapter = node.kind === "scene" || node.kind === "rehearsal" ? onConvertToChapter : undefined;
  const convertToScene = node.kind === "chapter" || node.kind === "rehearsal" ? onConvertToScene : undefined;
  const canShowBoundaryMenu = (
    canAddChapterScene ||
    canAddRehearsal ||
    !!convertToChapter ||
    !!convertToScene ||
    !!onOpenSceneDetail
  );
  const boundaryMenuControl = canShowBoundaryMenu ? (
    <RehearsalMarkInput
      variant="marker-control"
      canAddChapterScene={canAddChapterScene}
      canAddRehearsal={canAddRehearsal}
      onAddChapterBefore={onAddChapterBefore}
      onAddSceneBefore={onAddSceneBefore}
      onAddRehearsalBefore={onAddRehearsalBefore}
      onConvertToChapter={convertToChapter}
      onConvertToScene={convertToScene}
      onOpenSceneDetail={isRehearsal ? undefined : onOpenSceneDetail}
    />
  ) : null;
  const markerRootCombinedStyle: React.CSSProperties | undefined = (
    markerRootStyle || rehearsalMarkerStyle || markerGlowEndColor
      ? ({
          ...markerRootStyle,
          ...rehearsalMarkerStyle,
          ...(markerGlowEndColor ? { "--script-block-glow-fade-end": markerGlowEndColor } : {}),
        } as React.CSSProperties)
      : undefined
  );
  const openDeleteConfirmation = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (isScriptDragging) return;
    if (!onRequestDelete()) return;
    onDeleteConfirmChange?.(true);
  };
  const deleteConfirmationControl = (
    <span
      className="flex items-center gap-2 rounded bg-white/90 px-1.5 py-0.5 shadow-sm"
      data-script-confirmation="true"
    >
      <span className="whitespace-nowrap text-[10px] text-zinc-400">{deleteConfirmText}</span>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onDeleteConfirmChange?.(false);
          onRemove();
        }}
        className="shrink-0 whitespace-nowrap text-[10px] text-red-500 hover:text-red-700"
      >
        确认
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onDeleteConfirmChange?.(false);
        }}
        className="shrink-0 whitespace-nowrap text-[10px] text-zinc-400 hover:text-zinc-600"
      >
        取消
      </button>
    </span>
  );

  return (
    <div
      id={`marker-${node.id}`}
      data-script-marker={node.id}
      data-script-marker-selectable={!isRehearsal ? "true" : undefined}
      title={title}
      onClick={(e) => {
        if (isScriptDragging) return;
        if (isRehearsal) return;
        if (!canEdit) return;
        if ((e.target as HTMLElement | null)?.closest("[data-script-marker-title='true']")) return;
        onSelect(e);
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={markerRootCombinedStyle}
      className={`group/marker relative select-none text-left transition-colors ${
        isRehearsal
          ? ""
          : isDeleteHighlighted ? "bg-red-100" : isSelected ? "bg-[#eef3fa]" : "hover:bg-zinc-50/70"
      } ${markerMovedGlowClass} ${markerTocGlowClass} px-6 ${isRehearsal ? "overflow-visible" : ""}`}
    >
      {isRehearsal && isTocHighlighted ? (
        <div
          className="pointer-events-none absolute left-6 right-6 top-1/2 -translate-y-1/2 rounded script-toc-marker-glow"
          style={{ height: "1.25rem", "--script-block-glow-fade-end": isDeleteHighlighted ? "#fee2e2" : "#ffffff" } as React.CSSProperties}
        />
      ) : null}
      {dragTarget && (
        <div
          className={`pointer-events-none absolute left-4 right-4 z-10 border-t-2 ${
            dragTarget.kind !== "edge" && dragTarget.position === "before"
              ? isRehearsal ? "-top-3.5" : "-top-0.5"
              : isRehearsal ? "-bottom-3.5" : "-bottom-0.5"
          }`}
          style={{ borderColor: "#91a8ca" }}
        />
      )}
      {!isRehearsal && (canEdit || boundaryMenuControl) && (
        <div className="absolute left-0 top-1 bottom-1 z-20 w-12">
          {canEdit && isDeleteConfirmationOpen ? (
            <span
              className="absolute left-0 top-1/2 z-10 hidden -translate-y-1/2 translate-x-8 sm:block"
            >
              {deleteConfirmationControl}
            </span>
          ) : canEdit ? (
            <button
              type="button"
              data-script-confirmation="true"
              onPointerDown={openDeleteConfirmation}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
              style={{ left: MARKER_CONTROL_DELETE_LEFT_PX }}
              className="absolute top-1/2 hidden h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-[12px] leading-none text-zinc-300 opacity-0 transition-all hover:bg-red-100 hover:text-red-500 group-hover/marker:opacity-100 sm:flex"
              title="删除此标记"
              aria-label="删除此标记"
            >
              ×
            </button>
          ) : null}
          {canEdit && (
            <button
              type="button"
              draggable={!isReorderLocked}
              disabled={isReorderLocked}
              data-script-block-bar="true"
              data-script-marker-bar="true"
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onMouseDown={(e) => {
                if (e.shiftKey) e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(e);
                if (window.matchMedia("(max-width: 639px)").matches) onMobileMenuOpen?.();
              }}
              style={{ left: MARKER_CONTROL_BAR_LEFT_PX }}
              className={`absolute top-1/2 h-[max(1.25rem,calc(100%-0.25rem))] w-4 -translate-y-1/2 select-none rounded text-zinc-300 outline-none transition-colors hover:text-zinc-500 focus:outline-none focus-visible:outline-none sm:opacity-0 sm:transition-all sm:group-hover/marker:opacity-100 ${
                isReorderLocked
                  ? "cursor-not-allowed text-zinc-200 opacity-40"
                  : isDeleteHighlighted
                    ? "cursor-grab bg-red-100 text-red-500 hover:bg-red-100 hover:text-red-600 active:cursor-grabbing sm:opacity-100"
                    : `cursor-grab active:cursor-grabbing sm:hover:bg-[#dbe5f3] sm:hover:text-[#91a8ca] ${
                        isSelected ? "sm:bg-[#dbe5f3] sm:text-[#91a8ca] sm:opacity-100" : "sm:text-zinc-200"
                      }`
              }`}
              title="拖动调整标记位置"
              aria-label="拖动调整标记位置"
            >
              <span className="pointer-events-none flex h-full items-center justify-center text-[11px] font-bold sm:hidden">▶</span>
              <span className="pointer-events-none absolute bottom-1 left-1/2 top-1 hidden w-0.5 -translate-x-1/2 rounded bg-current sm:block" />
            </button>
          )}
          {boundaryMenuControl && (
            <span
              className="absolute top-1/2 hidden -translate-y-1/2 opacity-0 transition-opacity group-hover/marker:opacity-100 sm:block"
              style={{
                left: MARKER_CONTROL_TRIANGLE_LEFT_PX,
                marginTop: MARKER_CONTROL_TRIANGLE_TOP_OFFSET_PX,
              }}
            >
              {boundaryMenuControl}
            </span>
          )}
        </div>
      )}
      {isRehearsal ? (
        <div
          className="absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1"
          style={rehearsalFloatStyle}
        >
          <button
            type="button"
            draggable={canEdit && !isReorderLocked}
            data-script-block-bar="true"
            data-script-marker-bar="true"
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onMouseDown={(e) => {
              if (e.shiftKey) e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (isScriptDragging) return;
              if (!canEdit) return;
              onSelect(e);
            }}
            className={`inline-flex h-5 min-w-6 items-center justify-center rounded px-2 text-[10px] font-bold tracking-wider ${isDeleteConfirmationOpen ? "transition-none" : "transition-all"} ${
              isDeleteHighlighted
                ? "bg-red-100 text-red-600 ring-1 ring-red-300"
                : isSelected || isMobileMenuOpen ? "bg-[#eef3fa] text-[#637ca1] ring-1 ring-[#91a8ca]" : "bg-zinc-100 text-zinc-500"
            } ${
              canEdit && !isReorderLocked
                ? isDeleteHighlighted
                  ? "cursor-grab hover:bg-red-100 hover:text-red-700 active:cursor-grabbing"
                  : "cursor-grab hover:bg-[#dbe5f3] hover:text-[#637ca1] active:cursor-grabbing"
                : "cursor-default"
            }`}
            title="拖动调整排练记号位置"
            aria-label={`排练记号 ${node.mark}`}
          >
            {node.mark}
          </button>
          {canEdit && isDeleteConfirmationOpen ? (
            deleteConfirmationControl
          ) : canEdit ? (
            <button
              type="button"
              data-script-confirmation="true"
              onPointerDown={openDeleteConfirmation}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
              className={`hidden h-4 w-4 items-center justify-center rounded text-[12px] leading-none text-zinc-300 transition-all hover:bg-red-100 hover:text-red-500 sm:flex ${
                isSelected ? "opacity-100" : "opacity-0 group-hover/marker:opacity-100"
              }`}
              title="删除此排练记号"
              aria-label="删除此排练记号"
            >
              ×
            </button>
          ) : null}
          {!isDeleteConfirmationOpen && boundaryMenuControl ? (
            <span className="hidden h-4 items-center opacity-0 transition-opacity group-hover/marker:opacity-100 sm:flex">
              {boundaryMenuControl}
            </span>
          ) : null}
          {!isDeleteConfirmationOpen && (canEdit || boundaryMenuControl) ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMobileMenuOpen?.();
              }}
              className="flex h-5 w-4 items-center justify-center rounded text-zinc-300 transition-colors hover:text-zinc-500 sm:hidden"
              title="更多操作"
              aria-label="更多操作"
            >
              <span className="pointer-events-none flex h-full items-center justify-center text-[11px] font-bold">▶</span>
            </button>
          ) : null}
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-[7.5rem_1rem_minmax(0,1fr)] gap-x-2">
          <div className="col-span-3">
            <SceneHeader
              scene={node.scene}
              canEditName={canEdit}
              onNameChange={onSceneNameChange}
            />
          </div>
        </div>
      )}
    </div>
  );
}
