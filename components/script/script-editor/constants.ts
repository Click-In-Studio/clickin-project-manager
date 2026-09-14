import React from "react";

export const TOOLBAR_FOLD_HYSTERESIS_PX = 16;
export const COMPACT_STAGE_COMMENT_EDITOR_WIDTH_RATIO = 0.8;
export const LINE_INDEX_GUTTER_OFFSET_REM = 1.25;
export const LINE_INDEX_CONTROL_MIN_WIDTH_REM = 0.5;
export const SCRIPT_TOC_CENTER_EVENT = "script-toc-center-active";
export const SCRIPT_EDITOR_MAX_WIDTH_PX = 768; // Tailwind max-w-3xl
export const SCRIPT_BODY_HORIZONTAL_PADDING_REM = 1; // Tailwind px-4; side rails may overlap this padding.
export const SCRIPT_PRODUCTION_SIDEBAR_FULL_WIDTH_PX = 240;
export const SCRIPT_CONTENTS_MENU_MAX_WIDTH_REM = 11;
export const SCRIPT_TOC_RAIL_SCROLLBAR_WIDTH_REM = 2.5;
export const SCRIPT_TOC_RAIL_COMPACT_NUMBER_PADDING_REM = 1.75;
export const SCRIPT_TOC_RAIL_NUMBER_SLOT_REM = 0.5; // Minimum number slot width; widened when longer scene numbers need it.
export const SCRIPT_TOC_RAIL_LABEL_GAP_REM = 1.5;
export const SCRIPT_TOC_RAIL_SUBSCENE_INDENT_REM = 1; // Right-edge gap between chapter numbers and scene numbers.
export const SCRIPT_SCENE_DETAIL_RAIL_MIN_WIDTH_REM = 18;
export const SCRIPT_SCENE_DETAIL_RAIL_MAX_WIDTH_PX = 576;
export const SCRIPT_SCENE_DETAIL_RAIL_RIGHT_INSET_PX = 12;
export const SCRIPT_SCENE_DETAIL_MODE_BUTTON_EXTRA_INSET_REM = 0.25;
export const SCRIPT_SCENE_DETAIL_CAPTION_BG_HEIGHT_REM = 2.5;
export const SCRIPT_SCENE_DETAIL_MODE_LABEL = { view: "编辑", edit: "完成" } as const;
export const SCRIPT_TOC_ACTIVE_SCENE_TOP_ANCHOR_PX = 80;

export const REHEARSAL_MARKER_ROW_BASE_HEIGHT_REM = 1.75;
export const REHEARSAL_MARKER_ROW_HEIGHT_SCALE = 0;
export const REHEARSAL_MARKER_ROW_MIN_HEIGHT_PX = 1;
export const REHEARSAL_MARKER_FLOAT_LEFT_OFFSET_REM = -0.75;
export const MARKER_CONTROL_DELETE_LEFT_PX = 0;
export const MARKER_CONTROL_BAR_LEFT_PX = 12;
export const MARKER_CONTROL_TRIANGLE_LEFT_PX = MARKER_CONTROL_BAR_LEFT_PX * 2 - MARKER_CONTROL_DELETE_LEFT_PX + 1;
export const MARKER_CONTROL_TRIANGLE_TOP_OFFSET_PX = 0.6;
export const MARKER_DIVIDER_RIGHT_MARGIN = 0.2;

export function anchoredManagementPanelStyle(style: React.CSSProperties): React.CSSProperties {
  const availableHeight = typeof style.maxHeight === "number" ? `${style.maxHeight}px` : "calc(100vh - 1rem)";
  return { ...style, maxHeight: `min(28rem, ${availableHeight})`, overflowY: undefined };
}

export const CHECKBOX_OPTION_BASE_CLASS = "h-4 w-4 rounded border text-[10px] leading-none flex items-center justify-center transition-colors";
export const DISABLED_CHECKBOX_OPTION_CLASS = "cursor-not-allowed text-zinc-300 hover:bg-zinc-50";
export function checkboxOptionClass(selected: boolean): string {
  return `${CHECKBOX_OPTION_BASE_CLASS} ${
    selected
      ? "border-zinc-800 bg-zinc-800 text-white"
      : "border-zinc-300 text-transparent"
  }`;
}

export const COMMENT_BUBBLE_MIN_WIDTH_PX = 135;
export const COMMENT_BUBBLE_GAP_REM = 1.5; // Tailwind ml-6
export const SPEECH_TAIL_PIN_OFFSET_PX = 96;
export const SPEECH_TAIL_BASE_HALF_PX = 14;
export const SPEECH_TAIL_EDGE_INSET_PX = 24;
export const SIDE_PANEL_TOP_PX = 64; // Merged AppShell and ScriptEditor header
export const SIDE_PANEL_FALLBACK_WIDTH_PX = 270;
