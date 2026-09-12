/**
 * 剧本排版模版引擎入口（docs/script-template-engine.md）。
 */
import type { ScriptTextLayoutMode } from "../script-types";
import type { ScriptTemplate } from "./types";
import { LEGACY_CENTER, LEGACY_COMPACT } from "./presets/legacy";
import { BROADWAY_MUSICAL } from "./presets/broadway-musical";

export * from "./types";
export { planBlock, planSceneHeading, planScript, blockStyleIdOf, sceneNumberParts, toRoman, type PlanContext } from "./plan";
export { paginate, type Page, type PlacedItem, type PaginateOptions, type PaginateResult, type HeightOf } from "./paginate";
export { estimateItemHeight, columnWidths } from "./estimate";
export { estimateLines, stripHtml, textUnits } from "./text";

/**
 * 预设注册表，键是**带版本的 id**（`legacy-center@1`）。政策：预设一经发布即冻结；
 * 改样式 = 发新版本，演出存的是带版本的 id、由人主动升级。页码是剧组的共享坐标，
 * 不能因为我们调了一下间距就悄悄漂移（#349 的整个议题）。
 */
export const TEMPLATE_PRESETS: Record<string, ScriptTemplate> = {
  [LEGACY_CENTER.id]: LEGACY_CENTER,
  [LEGACY_COMPACT.id]: LEGACY_COMPACT,
  [BROADWAY_MUSICAL.id]: BROADWAY_MUSICAL,
};

/** 给选择界面：每个家族只列最新版本 */
export function listTemplatePresets(): ScriptTemplate[] {
  const latest = new Map<string, ScriptTemplate>();
  for (const t of Object.values(TEMPLATE_PRESETS)) {
    const [family, version] = t.id.split("@");
    const cur = latest.get(family);
    if (!cur || Number(version) > Number(cur.id.split("@")[1])) latest.set(family, t);
  }
  return [...latest.values()];
}

export function isKnownTemplateId(id: unknown): id is string {
  // hasOwn 而不是 in：注册表是普通对象，`"toString" in {}` 为真，会把原型上的东西当模版
  return typeof id === "string" && Object.hasOwn(TEMPLATE_PRESETS, id);
}

/** 无 templateId 时的回退映射：text_layout_mode → legacy 模版 */
export function templateForTextLayoutMode(mode: ScriptTextLayoutMode): ScriptTemplate {
  return mode === "compact" ? LEGACY_COMPACT : LEGACY_CENTER;
}

export function templateById(id: string | null | undefined, fallback: ScriptTextLayoutMode = "center"): ScriptTemplate {
  return isKnownTemplateId(id) ? TEMPLATE_PRESETS[id] : templateForTextLayoutMode(fallback);
}

/** 演出配置 → 模版：有 templateId 用它，否则按 textLayoutMode 回退 */
export function resolveTemplate(config: { templateId?: string | null; textLayoutMode: ScriptTextLayoutMode }): ScriptTemplate {
  return templateById(config.templateId, config.textLayoutMode);
}
