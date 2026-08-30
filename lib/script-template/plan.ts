/**
 * plan：规则求值，把块变成 LayoutItem（docs/script-template-engine.md §3）。
 *
 * 每个正文块按模版的块样式解析出槽文字，再按规则决定哪些槽可见、外沿多大、块前
 * 间距、断页提示。「若是本页首块」是分页器才知道的事，所以对 firstOnPage 的两种
 * 取值各求一次，产出 normal / pageTop 两个变体，分页器按位置选。
 */
import type { Block, Character, Scene } from "../script-types";
import { isMarkerBlock } from "../script-marker-blocks";
import { sameCharacters } from "../script-block-layout";
import { stripHtml } from "./text";
import type {
  BlockStyle, BlockStyleId, Effect, LayoutItem, Predicate, ResolvedSlot, Rule, ScriptTemplate, Slot, SlotField, Variant,
} from "./types";

export type PlanContext = {
  template: ScriptTemplate;
  characters: Character[];
  scenes: Scene[];
  stageDelimOpen: string;
  stageDelimClose: string;
};

export function blockStyleIdOf(block: Block): BlockStyleId {
  if (block.type === "stage") return "stage";
  if (block.lyric) return "lyric";
  return "dialogue";
}

type RuleFacts = {
  block: Block;
  prev: Block | null;
  isSceneStart: boolean;
  firstOnPage: boolean;
};

function evalPredicate(p: Predicate, f: RuleFacts, hidden: Set<string>): boolean {
  const { block, prev } = f;
  if (p.not && evalPredicate(p.not, f, hidden)) return false;
  if (p.all && !p.all.every((q) => evalPredicate(q, f, hidden))) return false;
  if (p.any && !p.any.some((q) => evalPredicate(q, f, hidden))) return false;
  if (p.type !== undefined && block.type !== p.type) return false;
  if (p.lyric !== undefined && !!block.lyric !== p.lyric) return false;
  if (p.hasCharacters !== undefined && (block.characterIds.length > 0) !== p.hasCharacters) return false;
  if (p.forceShowCharacterName !== undefined && !!block.forceShowCharacterName !== p.forceShowCharacterName) return false;
  if (p.hasPrev !== undefined && (prev !== null) !== p.hasPrev) return false;
  if (p.prevType !== undefined && prev?.type !== p.prevType) return false;
  if (p.prevHasCharacters !== undefined && (!!prev && prev.characterIds.length > 0) !== p.prevHasCharacters) return false;
  if (p.prevSameCharacters !== undefined && (!!prev && sameCharacters(prev.characterIds, block.characterIds)) !== p.prevSameCharacters) return false;
  if (p.prevSameScene !== undefined && (!!prev && prev.sceneId === block.sceneId) !== p.prevSameScene) return false;
  if (p.prevSameRehearsalMark !== undefined && (!!prev && prev.rehearsalMark === block.rehearsalMark) !== p.prevSameRehearsalMark) return false;
  if (p.isSceneStart !== undefined && f.isSceneStart !== p.isSceneStart) return false;
  if (p.firstOnPage !== undefined && f.firstOnPage !== p.firstOnPage) return false;
  if (p.slotVisible !== undefined && hidden.has(p.slotVisible)) return false;
  if (p.slotHidden !== undefined && !hidden.has(p.slotHidden)) return false;
  return true;
}

function applyRules(
  rules: Rule[],
  styleId: BlockStyleId,
  style: BlockStyle,
  facts: RuleFacts,
): { variant: Variant; gapBefore: number; breakBefore: boolean; keepWithNext: boolean } {
  const hidden = new Set<string>();
  let paddingTop = style.padding.top;
  let paddingBottom = style.padding.bottom;
  let gapBefore = 0;
  let breakBefore = false;
  let keepWithNext = false;
  const suffix: Record<string, string> = {};
  for (const rule of rules) {
    if (rule.styles && !rule.styles.includes(styleId)) continue;
    if (!evalPredicate(rule.when, facts, hidden)) continue;
    const e: Effect = rule.then;
    for (const id of e.hide ?? []) hidden.add(id);
    for (const id of e.show ?? []) hidden.delete(id);
    if (e.gapBefore !== undefined) gapBefore = e.gapBefore;
    if (e.paddingTop !== undefined) paddingTop = e.paddingTop;
    if (e.paddingBottom !== undefined) paddingBottom = e.paddingBottom;
    if (e.breakBefore === "page") breakBefore = true;
    if (e.keepWithNext !== undefined) keepWithNext = e.keepWithNext;
    if (e.suffix) Object.assign(suffix, e.suffix);
  }
  return { variant: { hidden, paddingTop, paddingBottom, suffix }, gapBefore, breakBefore, keepWithNext };
}

function characterLabel(block: Block, characters: Character[]): string {
  const byId = new Map(characters.map((c) => [c.id, c]));
  return block.characterIds
    .map((id) => byId.get(id))
    .filter((c): c is Character => !!c)
    .map((c) => {
      const ann = block.characterAnnotations[c.id];
      return ann ? `${c.name}（${ann}）` : c.name;
    })
    .join("、");
}

function fieldRaw(field: SlotField, block: Block | null, scene: Scene | null, ctx: PlanContext): string {
  switch (field) {
    case "character": return block ? characterLabel(block, ctx.characters) : "";
    case "stageComment": return block?.stageComment?.trim() ?? "";
    case "content": return block?.content ?? "";
    case "scene.number": return scene?.number ?? "";
    case "scene.name": return scene?.name ?? "";
  }
}

/** stageComment 逐行加分隔符（legacy：每行各自一对括号，行间保留换行） */
function decorateStageComment(text: string, ctx: PlanContext): string {
  return text.split(/\r\n|\r|\n/).map((line) => `${ctx.stageDelimOpen}${line}${ctx.stageDelimClose}`).join("\n");
}

function resolveSlot(slot: Slot, block: Block | null, scene: Scene | null, ctx: PlanContext): ResolvedSlot {
  const fields = Array.isArray(slot.field) ? slot.field : [slot.field];
  const hasCharacters = !!block && block.characterIds.length > 0;
  const parts: ResolvedSlot["parts"] = [];
  for (const field of fields) {
    if (field === "stageComment" && (slot.requireCharacters ?? true) && !hasCharacters) continue;
    let raw = fieldRaw(field, block, scene, ctx);
    if (field === "stageComment") {
      if (!raw) continue;
      raw = decorateStageComment(raw, ctx);
      parts.push({ field, raw, before: "", after: "" });
      continue;
    }
    if (!raw && field !== "content") continue;
    parts.push({ field, raw, before: slot.decorate?.before ?? "", after: slot.decorate?.after ?? "" });
  }
  const text = parts
    .map((p) => `${p.before}${p.field === "content" ? stripHtml(p.raw) : p.raw}${p.after}`)
    .join(slot.joiner ?? "\n");
  const empty = parts.every((p) => !p.raw);
  return { slot, text, parts, empty };
}

function resolveSlots(style: BlockStyle, block: Block | null, scene: Scene | null, ctx: PlanContext): ResolvedSlot[] {
  return style.slots.map((slot) => resolveSlot(slot, block, scene, ctx));
}

/** 单块求值：估算器的增量缓存按 (block, prev) 逐块调用；整篇 plan 也走它 */
export function planBlock(block: Block, prev: Block | null, ctx: PlanContext): Extract<LayoutItem, { kind: "block" }> {
  const styleId = blockStyleIdOf(block);
  const style = ctx.template.blockStyles[styleId];
  const isSceneStart = !!block.sceneId && block.sceneId !== prev?.sceneId;
  const facts = { block, prev, isSceneStart };
  const normal = applyRules(ctx.template.rules, styleId, style, { ...facts, firstOnPage: false });
  const pageTop = applyRules(ctx.template.rules, styleId, style, { ...facts, firstOnPage: true });
  return {
    kind: "block",
    id: block.id,
    block,
    styleId,
    style,
    slots: resolveSlots(style, block, null, ctx),
    normal: normal.variant,
    pageTop: pageTop.variant,
    gapBefore: normal.gapBefore,
    breakBefore: normal.breakBefore,
    keepWithNext: normal.keepWithNext,
  };
}

export function planSceneHeading(sceneId: string, scene: Scene | null, ctx: PlanContext): Extract<LayoutItem, { kind: "sceneHeading" }> {
  const style = ctx.template.blockStyles.sceneHeading;
  const variant: Variant = { hidden: new Set(), paddingTop: style.padding.top, paddingBottom: style.padding.bottom, suffix: {} };
  return {
    kind: "sceneHeading",
    id: `sh-${sceneId}`,
    scene,
    sceneId,
    style,
    slots: resolveSlots(style, null, scene, ctx),
    normal: variant,
    pageTop: variant,
  };
}

/**
 * 整篇：正文块按序求值；场次切换处插一个场次标题项。
 * prev 是**前一个正文块**（跳过 marker），与今天两条分页算法一致。
 * 场次不存在（估算器拿不到 scenes 时传空数组）也插标题项——估算器按一行计高，
 * 与 legacy `SCENE_HEADER_HEIGHT` 的口径相同；渲染层遇到 scene 为 null 自行跳过。
 */
export function planScript(blocks: Block[], ctx: PlanContext, opts?: { headingOnlyIfSceneKnown?: boolean }): LayoutItem[] {
  const sceneById = new Map(ctx.scenes.map((s) => [s.id, s]));
  const items: LayoutItem[] = [];
  let prev: Block | null = null;
  for (const block of blocks) {
    if (isMarkerBlock(block)) continue;
    if (block.sceneId && block.sceneId !== prev?.sceneId) {
      const scene = sceneById.get(block.sceneId) ?? null;
      if (scene || !opts?.headingOnlyIfSceneKnown) items.push(planSceneHeading(block.sceneId, scene, ctx));
    }
    items.push(planBlock(block, prev, ctx));
    prev = block;
  }
  return items;
}
