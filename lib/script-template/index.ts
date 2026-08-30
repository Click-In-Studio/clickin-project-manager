/**
 * 剧本排版模版引擎入口（docs/script-template-engine.md）。
 */
import type { ScriptTextLayoutMode } from "../script-types";
import type { ScriptTemplate } from "./types";
import { LEGACY_CENTER, LEGACY_COMPACT } from "./presets/legacy";

export * from "./types";
export { planBlock, planSceneHeading, planScript, blockStyleIdOf, type PlanContext } from "./plan";
export { paginate, type Page, type PlacedItem, type PaginateOptions, type PaginateResult, type HeightOf } from "./paginate";
export { estimateItemHeight, columnWidths } from "./estimate";
export { estimateLines, stripHtml, textUnits } from "./text";

export const TEMPLATE_PRESETS: Record<string, ScriptTemplate> = {
  [LEGACY_CENTER.id]: LEGACY_CENTER,
  [LEGACY_COMPACT.id]: LEGACY_COMPACT,
};

/** 无 templateId 时的回退映射：text_layout_mode → legacy 模版（T3 起演出可存 templateId） */
export function templateForTextLayoutMode(mode: ScriptTextLayoutMode): ScriptTemplate {
  return mode === "compact" ? LEGACY_COMPACT : LEGACY_CENTER;
}

export function templateById(id: string | null | undefined, fallback: ScriptTextLayoutMode = "center"): ScriptTemplate {
  return (id && TEMPLATE_PRESETS[id]) || templateForTextLayoutMode(fallback);
}
