// 剧本正文读工具族（production.script_* 读面，P1）。
//
// 设计（2026-08-31 定谳）：
// - 正文以**剧本方言**文本形态输出（lib/script-dialect.ts）：[b:<id>] 行头携带块 id，
//   id 是引用与（P2）改写的锚点；[m:<id>] 是只读结构锚点。
// - 页码是估算值（getEstimatedPageMap，主本版式）。定位组合拳：**页码粗着陆 +
//   相对窗口微调**——页码有偏差时用 script_read_window 沿 [b:] 锚点前后行走。
// - 读门 = 剧本页门票 script/*/blocks@view（与 block-search 路由同一把钥匙），
//   工具内 hasEffectiveGrant 实时判定（权限模板≠保证）。
// - 正文/场名/角色名是成员可写自由文本——回给模型前一律 neutralizeInjectionTags。
// - 整段读取有字数上限：章节过长给子段清单，单场过长截断并给续读锚点——
//   不静默截断（no silent caps）。

import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import { neutralizeInjectionTags } from "@/lib/agent-injection-safety";
import { hasEffectiveGrant } from "@/lib/grant-check";
import { getActiveVersionId, loadProduction, getEstimatedPageMap } from "@/lib/db";
import { buildMarkerLabelIndex, type MarkerLabelIndex } from "@/lib/script-generated-labels";
import { isMarkerBlock, markerBlockRank, withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script-marker-blocks";
import { serializeBlocksToDialect, SCRIPT_DIALECT_POINTER_READ } from "@/lib/script-dialect";
import type { Block, Character } from "@/lib/script-types";

export const DENIED_SCRIPT_VIEW = "权限被拒绝：你没有查看剧本正文的权限（需要 node:script/*/blocks@view）。";
const NO_VERSION = "该制作还没有剧本版本。";
const NO_BLOCKS = "（剧本还没有任何正文块）";

/** 单次整段读取的字数上限（超出给子段清单/截断续读锚点） */
export const MAX_SECTION_CHARS = 20000;
const WINDOW_DEFAULT_BEFORE = 6;
const WINDOW_DEFAULT_AFTER = 12;
const WINDOW_MAX = 50;
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 30;

// ─── 读门 + 索引 ──────────────────────────────────────────────────────────────

async function scriptReadGate(userId: string, productionId: string): Promise<string | null> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (!await hasEffectiveGrant(resolved.actor, productionId, "script", "*", "blocks", "view")) return DENIED_SCRIPT_VIEW;
  return null;
}

type ScriptIndex = {
  blocks: Block[]; // canonical 投影后的全量序列（含 marker），与分页器/打印同源
  characters: Character[];
  labels: MarkerLabelIndex;
  markerById: Map<string, Block>;
  pageMap: () => Promise<Record<string, number>>;
};

/** 一次调用只经 loadProduction 读一次正文（与 block-search 路由同款收敛）。 */
async function loadScriptIndex(productionId: string): Promise<ScriptIndex | string> {
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return NO_VERSION;
  const loaded = await loadProduction(productionId, versionId);
  if (!loaded) return NO_VERSION;
  const owned = withMarkerOwnership(loaded.state.blocks);
  const blocks = withLegacyOwnershipProjection(owned);
  let pageMapPromise: Promise<Record<string, number>> | null = null;
  return {
    blocks,
    characters: loaded.state.characters,
    // labels 与 markerById 同源自 blocks：legacy 投影不动 id/type/markerMeta，
    // owned 与 blocks 对标签索引等价，但同源派生免去"两张图对不上"的疑虑（AI review #400-2）
    labels: buildMarkerLabelIndex(blocks),
    markerById: new Map(blocks.filter(isMarkerBlock).map((b) => [b.id, b])),
    pageMap: () => pageMapPromise ??= getEstimatedPageMap(productionId, versionId, loaded.state),
  };
}

// ─── 展示辅助 ─────────────────────────────────────────────────────────────────

const MARKER_KIND_LABELS: Record<string, string> = {
  chapter_marker: "章", scene_marker: "场", rehearsal_marker: "排练标记",
};

function markerTitle(block: Block): string {
  return (block.markerMeta?.name ?? "").trim() || (block.content ?? "").trim() || "（未命名）";
}

function markerDesc(index: ScriptIndex, marker: Block): string {
  const label = index.labels.labelByMarkerId.get(marker.id);
  return `【${MARKER_KIND_LABELS[marker.type] ?? "段"}】${label ? `${label} ` : ""}${markerTitle(marker)}`;
}

/** 正文块的所在位置（场号 + 场名）。 */
function blockLocation(index: ScriptIndex, block: Block): string {
  const marker = block.sceneId ? index.markerById.get(block.sceneId) : null;
  if (!marker) return "（无所属场次）";
  const label = index.labels.labelByMarkerId.get(marker.id);
  return `${label ? `${label} ` : ""}${markerTitle(marker)}`;
}

function speakerNames(index: ScriptIndex, block: Block): string {
  const byId = new Map(index.characters.map((c) => [c.id, c.name]));
  const names = block.characterIds.map((id) => byId.get(id)).filter((n): n is string => !!n);
  return names.join("、");
}

function serializeRange(index: ScriptIndex, range: Block[]): string {
  return serializeBlocksToDialect(range, index.characters, { labelByMarkerId: index.labels.labelByMarkerId });
}

/** 页码失败降级为"无页码"，但必须留痕——静默吞错会让 page_map 回归在线上隐形（AI review #400-1）。 */
function pageMapSafe(index: ScriptIndex): Promise<Record<string, number>> {
  return index.pageMap().catch((err) => {
    console.error("[script-tools] 估算页码读取失败（本次输出降级为无页码）:", err);
    return {};
  });
}

async function pageSpanOf(index: ScriptIndex, range: Block[]): Promise<string | null> {
  const pm = await pageMapSafe(index);
  const pages = range.filter((b) => !isMarkerBlock(b)).map((b) => pm[b.id]).filter((p): p is number => typeof p === "number");
  if (pages.length === 0) return null;
  const lo = Math.min(...pages);
  const hi = Math.max(...pages);
  return lo === hi ? `估算页码 ${lo}` : `估算页码 ${lo}–${hi}`;
}

/** 段落边界：从 marker 起，到下一个同级或更高级 marker 为止（含内部低级 marker）。 */
function sectionEndIndex(blocks: Block[], startIdx: number): number {
  const rank = markerBlockRank(blocks[startIdx]) ?? 0;
  for (let i = startIdx + 1; i < blocks.length; i++) {
    const r = markerBlockRank(blocks[i]);
    if (r !== null && r <= rank) return i;
  }
  return blocks.length;
}

// ─── production.script_read_section ──────────────────────────────────────────

export async function scriptReadSection(userId: string, productionId: string, sectionId: string): Promise<string> {
  const denied = await scriptReadGate(userId, productionId);
  if (denied) return denied;
  const index = await loadScriptIndex(productionId);
  if (typeof index === "string") return index;
  if (index.blocks.length === 0) return NO_BLOCKS;

  const startIdx = index.blocks.findIndex((b) => b.id === sectionId);
  if (startIdx < 0 || !isMarkerBlock(index.blocks[startIdx])) {
    return "没有找到该章节/场次/排练标记——sectionId 用 production.scene_list 里的 id（正文中的 [m:<id>] 锚点同义）。";
  }
  const range = index.blocks.slice(startIdx, sectionEndIndex(index.blocks, startIdx));
  const textCount = range.filter((b) => !isMarkerBlock(b)).length;
  const serialized = serializeRange(index, range);

  if (serialized.length > MAX_SECTION_CHARS) {
    const inner = range.slice(1).filter(isMarkerBlock);
    if (inner.length > 0) {
      // 子段清单：按 range 内出现的最高级 marker 分段计数
      const minRank = Math.min(...inner.map((b) => markerBlockRank(b) ?? 9));
      const children = inner.filter((b) => (markerBlockRank(b) ?? 9) === minRank);
      const childSet = new Set(children.map((b) => b.id));
      const counts = new Map<string, number>();
      let current: string | null = null;
      for (const b of range.slice(1)) {
        if (isMarkerBlock(b)) { if (childSet.has(b.id)) current = b.id; continue; }
        if (current) counts.set(current, (counts.get(current) ?? 0) + 1);
      }
      const lines = children.map((c) => `- ${markerDesc(index, c)}（id: ${c.id}）｜正文 ${counts.get(c.id) ?? 0} 块`);
      return neutralizeInjectionTags([
        `${markerDesc(index, range[0])}（id: ${sectionId}）共 ${textCount} 个正文块、约 ${serialized.length} 字，超出单次读取上限（${MAX_SECTION_CHARS} 字）。请分子段读取：`,
        ...lines,
        "（对上面的子段逐个调用 production.script_read_section）",
      ].join("\n"));
    }
    // 单段过长：截断 + 给续读锚点（不静默截断）
    let cut = 1;
    let used = 0;
    for (let i = 0; i < range.length; i++) {
      used += serializeBlocksToDialect([range[i]], index.characters, { labelByMarkerId: index.labels.labelByMarkerId }).length + 1;
      if (used > MAX_SECTION_CHARS) break;
      cut = i + 1;
    }
    const part = range.slice(0, cut);
    const shown = part.filter((b) => !isMarkerBlock(b)).length;
    return neutralizeInjectionTags([
      `${markerDesc(index, range[0])}（id: ${sectionId}）｜正文 ${textCount} 块（本段过长，已截断到前 ${shown} 块）`,
      "",
      serializeRange(index, part),
      "",
      `…（未完；继续读请用 production.script_read_window，以 [b:${part[part.length - 1].id}] 为锚点向后取）`,
      SCRIPT_DIALECT_POINTER_READ,
    ].join("\n"));
  }

  const pageSpan = await pageSpanOf(index, range);
  return neutralizeInjectionTags([
    `${markerDesc(index, range[0])}（id: ${sectionId}）｜正文 ${textCount} 块${pageSpan ? `｜${pageSpan}` : ""}`,
    "",
    serialized,
    "",
    SCRIPT_DIALECT_POINTER_READ,
  ].join("\n"));
}

// ─── production.script_read_window ───────────────────────────────────────────

export async function scriptReadWindow(
  userId: string,
  productionId: string,
  blockId: string,
  before?: number,
  after?: number,
): Promise<string> {
  const denied = await scriptReadGate(userId, productionId);
  if (denied) return denied;
  const index = await loadScriptIndex(productionId);
  if (typeof index === "string") return index;
  if (index.blocks.length === 0) return NO_BLOCKS;

  const idx = index.blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) return "没有找到该块——blockId 用剧本读取/搜索结果里 [b:]/[m:] 标注的 id。";
  const clamp = (v: number | undefined, dflt: number) =>
    Math.max(0, Math.min(WINDOW_MAX, typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt));
  const b0 = clamp(before, WINDOW_DEFAULT_BEFORE);
  const a0 = clamp(after, WINDOW_DEFAULT_AFTER);
  const start = Math.max(0, idx - b0);
  const end = Math.min(index.blocks.length, idx + a0 + 1);
  const range = index.blocks.slice(start, end);

  const anchor = index.blocks[idx];
  const pm = await pageMapSafe(index);
  const page = pm[anchor.id];
  const where = isMarkerBlock(anchor) ? markerDesc(index, anchor) : blockLocation(index, anchor);
  const prevHint = start > 0 ? `继续向前：以 [b:${index.blocks[start - 1].id}] 为锚点再调一次` : "已到剧本开头";
  const nextHint = end < index.blocks.length ? `继续向后：以 [b:${index.blocks[end - 1].id}] 为锚点再调一次` : "已到剧本结尾";
  return neutralizeInjectionTags([
    `锚点 [b:${anchor.id}]｜${where}${typeof page === "number" ? `｜估算页码 ${page}` : ""}｜窗口 前${idx - start}/后${end - 1 - idx} 块`,
    "",
    serializeRange(index, range),
    "",
    `${prevHint}；${nextHint}。`,
    SCRIPT_DIALECT_POINTER_READ,
  ].join("\n"));
}

// ─── production.script_search ────────────────────────────────────────────────

function snippet(text: string, qLower: string): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(qLower);
  const start = Math.max(0, at - 20);
  const end = Math.min(text.length, at + qLower.length + 40);
  const body = text.slice(start, end).replace(/\s*\n+\s*/g, " / ");
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

export async function scriptSearch(
  userId: string,
  productionId: string,
  opts: { query: string; speaker?: string; limit?: number },
): Promise<string> {
  const denied = await scriptReadGate(userId, productionId);
  if (denied) return denied;
  const q = opts.query.trim();
  if (!q) return "搜索词不能为空。";
  const index = await loadScriptIndex(productionId);
  if (typeof index === "string") return index;
  if (index.blocks.length === 0) return NO_BLOCKS;

  let speakerIds: Set<string> | null = null;
  if (opts.speaker?.trim()) {
    const name = opts.speaker.trim();
    const matched = index.characters.filter((c) => c.name === name).map((c) => c.id);
    if (matched.length === 0) {
      return neutralizeInjectionTags(`没有叫「${name}」的角色——角色名从 production.character_list 取。`);
    }
    speakerIds = new Set(matched);
  }
  const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, opts.limit ?? SEARCH_DEFAULT_LIMIT));
  const qLower = q.toLowerCase();

  type Hit = { block: Block; from: "content" | "stageComment" };
  const hits: Hit[] = [];
  for (const block of index.blocks) {
    if (isMarkerBlock(block)) continue;
    if (speakerIds && !block.characterIds.some((id) => speakerIds.has(id))) continue;
    if ((block.content ?? "").toLowerCase().includes(qLower)) hits.push({ block, from: "content" });
    else if ((block.stageComment ?? "").toLowerCase().includes(qLower)) hits.push({ block, from: "stageComment" });
  }
  if (hits.length === 0) return neutralizeInjectionTags(`没有找到包含「${q}」的正文块${opts.speaker ? `（说话人过滤：${opts.speaker}）` : ""}。`);

  const pm = await pageMapSafe(index);
  const shown = hits.slice(0, limit).map(({ block, from }) => {
    const page = pm[block.id];
    const who = block.type === "stage" ? "〔舞台提示〕" : (speakerNames(index, block) || "〔无说话人〕");
    const text = from === "stageComment" ? `提示:${snippet(block.stageComment ?? "", qLower)}` : snippet(block.content ?? "", qLower);
    return `- [b:${block.id}]｜${typeof page === "number" ? `第 ${page} 页` : "页码未知"}｜${blockLocation(index, block)}｜${who}：${text}`;
  });
  return neutralizeInjectionTags([
    `共命中 ${hits.length} 处${hits.length > limit ? `（显示前 ${limit} 条）` : ""}：`,
    ...shown,
    "看上下文用 production.script_read_window（以 [b:] 的 id 为锚点）。页码为估算值。",
  ].join("\n"));
}

// ─── production.script_read_page ─────────────────────────────────────────────

export async function scriptReadPage(userId: string, productionId: string, page: number): Promise<string> {
  const denied = await scriptReadGate(userId, productionId);
  if (denied) return denied;
  if (!Number.isFinite(page) || page < 1) return "页码必须是 ≥1 的整数。";
  const index = await loadScriptIndex(productionId);
  if (typeof index === "string") return index;
  if (index.blocks.length === 0) return NO_BLOCKS;

  const pm = await pageMapSafe(index);
  const pages = Object.values(pm);
  const maxPage = pages.length > 0 ? Math.max(...pages) : 0;
  const idxs = index.blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => pm[b.id] === page)
    .map(({ i }) => i);
  if (idxs.length === 0) {
    return maxPage > 0
      ? `第 ${page} 页没有内容。当前剧本估算页码范围 1–${maxPage}。`
      : "当前剧本还没有页码数据（正文为空或页码尚未估算）。";
  }
  // 取该页首尾块之间的完整区间（把夹在中间的 marker 锚点一并带上，保住结构语境）
  const range = index.blocks.slice(idxs[0], idxs[idxs.length - 1] + 1);
  const textCount = range.filter((b) => !isMarkerBlock(b)).length;
  const neighbors = [page > 1 ? `第 ${page - 1} 页` : null, page < maxPage ? `第 ${page + 1} 页` : null]
    .filter(Boolean).join("、");
  return neutralizeInjectionTags([
    `第 ${page} 页（估算页码，按主本版式，与打印稿可能有小幅偏差）｜正文 ${textCount} 块｜全本约 ${maxPage} 页`,
    "",
    serializeRange(index, range),
    "",
    `${neighbors ? `相邻页：${neighbors}。` : ""}页码有偏差、没找到目标时，用 production.script_read_window 沿 [b:] 锚点前后行走。`,
    SCRIPT_DIALECT_POINTER_READ,
  ].join("\n"));
}
