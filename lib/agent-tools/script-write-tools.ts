// 剧本正文写工具族（production.script_propose_* 写面，P2）。
//
// 模式照抄构作族（dramaturgy-tools.ts）：
//   Plan（参数/业务错误 → block 回模型不弹卡；否则给出 wants + notes + run 闭包）
//   → service preflight 用 previewScriptProposal 预算权限三态进确认卡
//   → 用户批准后 runScriptProposal 再查一遍权限（真正的安全边界）→ 执行。
//
// 两个工具、一条管线：
//   script_propose_rewrite     段级连续改写——AI 输出整段方言文本，
//                              applyDialectToBlocks 按 id 往返协议算出目标状态
//   script_propose_edit_blocks 单/多块精修——结构化字段逐块改/插/删
// 两者殊途同归：目标 blocks → diffState 算最小 patch → requiredPermissions 反推
// 所需钥匙（与编辑器 PATCH 路由同一套判定）→ applyPatchToDB（CoW/锁/cue 漂移/
// page_map 全继承）。块 id 不变即锚点不变——评论/cue/标签不受改写影响。
//
// 无人值守：不声明 unattended → 缺省 deny。剧本正文写入不进定时任务白名单。

import { randomUUID } from "node:crypto";
import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import type { GrantActor } from "@/lib/grant-check";
import { canAccessNodesBatch, formatNodeKey, type NodeAccessResult, type NodeKeyParts } from "@/lib/grant-template";
import { getActiveVersionId, loadProduction, applyPatchToDB } from "@/lib/db";
import { tickAndBroadcastSeq } from "@/lib/server-cache";
import { diffState, requiredPermissions, type ScriptPermissionKey, type ScriptPatch } from "@/lib/script-ops";
import { applyDialectToBlocks, resolveSpeakerRefs, type ApplyDialectSummary, type ParsedSpeaker } from "@/lib/script-dialect";
import { sectionEndIndex } from "./script-tools";
import { isMarkerBlock, withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script-marker-blocks";
import type { Block, ScriptState } from "@/lib/script-types";

const ARCHIVED = "该制作已归档，无法修改。";
const NO_VERSION = "该制作还没有剧本版本。";

export const MAX_EDIT_OPS = 60;

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s*\n+\s*/g, " / ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

// ─── 写前置（与构作族同款） ────────────────────────────────────────────────────

type WriteCtx = { actor: GrantActor; versionId: string };

async function writePrelude(userId: string, productionId: string): Promise<WriteCtx | string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return ARCHIVED;
  // 写只落 head：工具没有 versionId 参数，永远取活跃版本
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return NO_VERSION;
  return { actor: resolved.actor, versionId };
}

/** 与读工具同一条 canonical 投影链：改写区间必须与读出的区间逐块一致。 */
async function loadCanonicalState(productionId: string, versionId: string): Promise<ScriptState | null> {
  const state = (await loadProduction(productionId, versionId))?.state;
  if (!state) return null;
  return { ...state, blocks: withLegacyOwnershipProjection(withMarkerOwnership(state.blocks)) };
}

// ─── 权限：patch → 钥匙（与编辑器 PATCH 路由同一套 requiredPermissions） ─────────

type Want = { label: string; node: NodeKeyParts; page: string };
type KeyCheck = Want & { key: string; result: NodeAccessResult };

/** ScriptPermissionKey → 卡片/拒绝文案里的钥匙描述。正文写通常只命中前两把；
 *  跨场移动会命中 scene/*@edit——全键覆盖以防 diff 触到边角。 */
const KEY_WANTS: Record<ScriptPermissionKey, Want> = {
  "node:script/*/blocks@edit": { label: "编辑剧本正文", node: { resourceType: "script", resourceId: "*", resourceSub: "blocks", verb: "edit" }, page: "剧本" },
  "node:script/*/rehearsal_marks@create": { label: "调整排练标记", node: { resourceType: "script", resourceId: "*", resourceSub: "rehearsal_marks", verb: "create" }, page: "剧本" },
  "node:character/*@edit": { label: "编辑角色", node: { resourceType: "character", resourceId: "*", resourceSub: "*", verb: "edit" }, page: "角色" },
  "node:scene/*@create": { label: "新建章节/场次", node: { resourceType: "scene", resourceId: "*", resourceSub: "*", verb: "create" }, page: "构作" },
  "node:scene/*@edit": { label: "调整场次结构", node: { resourceType: "scene", resourceId: "*", resourceSub: "*", verb: "edit" }, page: "构作" },
  "node:scene/*@delete": { label: "删除章节/场次", node: { resourceType: "scene", resourceId: "*", resourceSub: "*", verb: "delete" }, page: "构作" },
  "node:scene/*/meta/name@edit": { label: "修改场次名称", node: { resourceType: "scene", resourceId: "*", resourceSub: "meta/name", verb: "edit" }, page: "构作" },
  "node:scene/*/meta/type@edit": { label: "修改章/场类型", node: { resourceType: "scene", resourceId: "*", resourceSub: "meta/type", verb: "edit" }, page: "构作" },
  "node:scene/*/synopsis@edit": { label: "修改梗概", node: { resourceType: "scene", resourceId: "*", resourceSub: "synopsis", verb: "edit" }, page: "构作" },
  "node:scene/*/action_line@edit": { label: "修改行动线", node: { resourceType: "scene", resourceId: "*", resourceSub: "action_line", verb: "edit" }, page: "构作" },
  "node:scene/*/music@edit": { label: "修改音乐", node: { resourceType: "scene", resourceId: "*", resourceSub: "music", verb: "edit" }, page: "构作" },
  "node:scene/*/stage_notes@edit": { label: "修改舞台呈现", node: { resourceType: "scene", resourceId: "*", resourceSub: "stage_notes", verb: "edit" }, page: "构作" },
  "node:scene/*/meta/expected_duration@edit": { label: "修改预计时长", node: { resourceType: "scene", resourceId: "*", resourceSub: "meta/expected_duration", verb: "edit" }, page: "构作" },
};

function wantsFromPatch(patch: ScriptPatch, prevState: ScriptState): Want[] {
  return [...requiredPermissions(patch, prevState)].map((key) => KEY_WANTS[key]).filter(Boolean);
}

async function checkNodes(actor: GrantActor, productionId: string, wants: Want[]): Promise<KeyCheck[]> {
  const uniq = new Map<string, Want>();
  for (const w of wants) uniq.set(formatNodeKey(w.node), w);
  const list = [...uniq.entries()];
  const results = await canAccessNodesBatch(actor, productionId, list.map(([, w]) => w.node));
  return list.map(([key, w], i) => ({ ...w, key, result: results[i] }));
}

const applyUrl = (key: string, productionId: string) => `/unauthorized?resource=${encodeURIComponent(key)}&id=${productionId}`;

function describeBlockedKey(c: KeyCheck, productionId: string): string {
  const r = c.result;
  if (r.allowed) return `✅ ${c.label}`;
  if (r.reason === "needs_self_confirm") {
    return `🔓 ${c.label}：你有这项权限的资格但尚未激活（${c.key}）——请到「${c.page}」页面点击激活提示，激活后再重试。`;
  }
  if (r.reason === "needs_approval") return `📝 ${c.label}：需要申请（${c.key}），申请入口：${applyUrl(c.key, productionId)}`;
  return `⛔ ${c.label}：没有申请入口（${c.key}）。`;
}

function denialText(blocked: KeyCheck[], productionId: string): string {
  return [
    "权限被拒绝，未做任何变更。缺少以下权限：",
    ...blocked.map((c) => `- ${describeBlockedKey(c, productionId)}`),
    "🔓=有资格待激活（用户到页面点一下即可）；📝=需走申请；⛔=无入口。",
  ].join("\n");
}

// ─── 共同尾段：目标 blocks → patch → wants/notes/run ──────────────────────────

type Plan =
  | { error: string }
  | { wants: Want[]; notes: string[]; run: () => Promise<string> };

function diffNotes(prevById: Map<string, Block>, nextBlocks: Block[], summary: ApplyDialectSummary): string[] {
  const nextById = new Map(nextBlocks.map((b) => [b.id, b]));
  const lines: string[] = [
    `新增 ${summary.inserted.length} 块 / 修改 ${summary.updated.length} 块 / 删除 ${summary.deleted.length} 块 / 保留 ${summary.retained} 块`,
  ];
  for (const id of summary.updated) lines.push(`改：${clip(nextById.get(id)?.content ?? "", 40)}`);
  for (const id of summary.inserted) lines.push(`增：${clip(nextById.get(id)?.content ?? "", 40)}`);
  for (const id of summary.deleted) lines.push(`删：${clip(prevById.get(id)?.content ?? "", 40)}`);
  return lines;
}

function finishPlan(
  ctx: WriteCtx,
  productionId: string,
  prevState: ScriptState,
  nextBlocks: Block[],
  summary: ApplyDialectSummary,
  headline: string,
): Plan {
  const nextState: ScriptState = { ...prevState, blocks: nextBlocks };
  const patch: ScriptPatch = { ...diffState(prevState, nextState, 0), clientSeq: 0 };
  if (patch.blockOps.length === 0 && patch.charOps.length === 0 && patch.sceneOps.length === 0) {
    return { error: "内容与现状相同，未做任何变更。" };
  }
  const prevById = new Map(prevState.blocks.map((b) => [b.id, b]));
  const notes = [headline, ...diffNotes(prevById, nextBlocks, summary)];
  return {
    wants: wantsFromPatch(patch, prevState),
    notes,
    run: async () => {
      await applyPatchToDB(productionId, ctx.versionId, patch);
      tickAndBroadcastSeq(productionId, ctx.versionId);
      return [
        `已完成剧本改动：新增 ${summary.inserted.length} 块、修改 ${summary.updated.length} 块、删除 ${summary.deleted.length} 块（保留 ${summary.retained} 块未动）。`,
        "保留的块 id 未变，其上的评论/cue/标签锚点不受影响。",
      ].join("\n");
    },
  };
}

// ─── script_propose_rewrite：段级连续改写 ─────────────────────────────────────

export type RewriteArgs = { sectionId?: unknown; dialect?: unknown };

async function planRewrite(ctx: WriteCtx, productionId: string, args: RewriteArgs): Promise<Plan> {
  const sectionId = typeof args.sectionId === "string" ? args.sectionId : "";
  const dialect = typeof args.dialect === "string" ? args.dialect : "";
  if (!sectionId) return { error: "必须提供 sectionId（来自 production.scene_list 或 [m:] 锚点）。" };
  if (!dialect.trim()) return { error: "dialect 为空——请提交改写后的整段方言文本（先用 production.script_read_section 读出该段）。" };

  const state = await loadCanonicalState(productionId, ctx.versionId);
  if (!state) return { error: NO_VERSION };
  const startIdx = state.blocks.findIndex((b) => b.id === sectionId);
  if (startIdx < 0 || !isMarkerBlock(state.blocks[startIdx])) {
    return { error: "没有找到该章节/场次/排练标记——sectionId 用 production.scene_list 里的 id。" };
  }
  const range = state.blocks.slice(startIdx, sectionEndIndex(state.blocks, startIdx));

  const res = applyDialectToBlocks({
    allBlocks: state.blocks,
    rangeBlockIds: range.map((b) => b.id),
    dialect,
    characters: state.characters,
    newId: randomUUID,
  });
  if (!res.ok) {
    return {
      error: [
        "剧本方言解析失败（未提交给用户确认，未做任何变更）：",
        ...res.errors.map((e) => `- ${e.line > 0 ? `第 ${e.line} 行：` : ""}${e.message}`),
        "请修正后重新调用；方言完整说明用 production.script_dialect_ref 获取。",
      ].join("\n"),
    };
  }

  const marker = state.blocks[startIdx];
  const title = (marker.markerMeta?.name ?? "").trim() || (marker.content ?? "").trim() || "（未命名）";
  return finishPlan(ctx, productionId, state, res.blocks, res.summary, `目标段：${clip(title, 30)}（id: ${sectionId}）`);
}

// ─── script_propose_edit_blocks：单/多块精修 ──────────────────────────────────

export type EditUpdateItem = {
  blockId: string;
  content?: string;
  /** 舞台提示（挂在块上）；空串 = 清除 */
  stageComment?: string;
  /** 说话人完整新列表（整体替换）：元素形如「张三」「张三（低声）」「#<角色id>」 */
  speakers?: string[];
  type?: "dialogue" | "stage";
  lyric?: boolean;
  forceShowCharacterName?: boolean;
};

export type EditInsertItem = {
  /** 插在这个块之后（可以是正文块或 [m:] 标记 id；标记 id = 插在该段最前） */
  afterBlockId: string;
  content: string;
  type?: "dialogue" | "stage";
  speakers?: string[];
  stageComment?: string;
  lyric?: boolean;
};

export type EditBlocksArgs = { updates?: unknown; inserts?: unknown; deletes?: unknown };

const norm = (s: string): string => s.replace(/\r\n?/g, "\n");

function markerGuard(block: Block | undefined, id: string): string | null {
  if (!block) return `没有找到块 ${id}——blockId 用剧本读取/搜索结果里 [b:] 标注的 id（未做任何变更）。`;
  if (isMarkerBlock(block)) {
    return `「${id}」是章节/场次/排练标记——标题与结构请用 scene_propose_* 工具；本工具只改正文块（未做任何变更）。`;
  }
  return null;
}

function speakerFields(speakers: ParsedSpeaker[]): { characterIds: string[]; characterAnnotations: Record<string, string> } {
  const ann: Record<string, string> = {};
  for (const s of speakers) if (s.annotation) ann[s.charId] = s.annotation;
  return { characterIds: speakers.map((s) => s.charId), characterAnnotations: ann };
}

/** 只改提供的字段；语义未变时返回原对象（与方言 mergeRetained 同款，保住空 patch）。 */
function mergeStructured(original: Block, u: EditUpdateItem, speakers: ParsedSpeaker[] | null): Block | { error: string } {
  const changes: Partial<Block> = {};
  const targetType = u.type ?? original.type;
  if (targetType === "stage" && (speakers?.length || u.lyric === true)) {
    return { error: `块 ${original.id}：舞台提示块（type=stage）不能有说话人或歌词标记。` };
  }
  if (u.type !== undefined && u.type !== original.type) {
    changes.type = u.type;
    if (u.type === "stage" && original.lyric) changes.lyric = false;
  }
  if (typeof u.content === "string" && norm(original.content ?? "") !== norm(u.content)) changes.content = norm(u.content);
  if (typeof u.stageComment === "string" && norm(original.stageComment ?? "") !== norm(u.stageComment)) {
    changes.stageComment = u.stageComment === "" ? null : norm(u.stageComment);
  }
  if (typeof u.lyric === "boolean" && targetType !== "stage" && u.lyric !== original.lyric) changes.lyric = u.lyric;
  if (typeof u.forceShowCharacterName === "boolean" && (original.forceShowCharacterName ?? false) !== u.forceShowCharacterName) {
    changes.forceShowCharacterName = u.forceShowCharacterName;
  }
  if (speakers) {
    const next = speakerFields(speakers);
    const sameIds = original.characterIds.length === next.characterIds.length &&
      original.characterIds.every((id, i) => id === next.characterIds[i]);
    const sameAnn = next.characterIds.every((id) => (original.characterAnnotations[id] ?? "") === (next.characterAnnotations[id] ?? ""));
    if (!sameIds || !sameAnn) {
      changes.characterIds = next.characterIds;
      changes.characterAnnotations = next.characterAnnotations;
    }
  }
  return Object.keys(changes).length === 0 ? original : { ...original, ...changes };
}

async function planEditBlocks(ctx: WriteCtx, productionId: string, args: EditBlocksArgs): Promise<Plan> {
  const updates = Array.isArray(args.updates) ? (args.updates as EditUpdateItem[]) : [];
  const inserts = Array.isArray(args.inserts) ? (args.inserts as EditInsertItem[]) : [];
  const deletes = Array.isArray(args.deletes) ? (args.deletes as string[]).map(String) : [];
  const total = updates.length + inserts.length + deletes.length;
  if (total === 0) return { error: "updates/inserts/deletes 全为空，未做任何变更。" };
  if (total > MAX_EDIT_OPS) return { error: `一次最多 ${MAX_EDIT_OPS} 处改动，请分批。` };

  const state = await loadCanonicalState(productionId, ctx.versionId);
  if (!state) return { error: NO_VERSION };
  const byId = new Map(state.blocks.map((b) => [b.id, b]));

  // 目标集合冲突检查
  const touched = new Set<string>();
  for (const id of [...updates.map((u) => u?.blockId), ...deletes]) {
    if (typeof id !== "string" || !id) return { error: "每一项都必须带 blockId（未做任何变更）。" };
    if (touched.has(id)) return { error: `块 ${id} 在同一批里被重复操作（未做任何变更）。` };
    touched.add(id);
  }

  const summary: ApplyDialectSummary = { inserted: [], updated: [], deleted: [], retained: 0 };
  let nextBlocks = state.blocks.slice();

  for (const u of updates) {
    const original = byId.get(u.blockId);
    const guard = markerGuard(original, u.blockId);
    if (guard) return { error: guard };
    let speakers: ParsedSpeaker[] | null = null;
    if (u.speakers !== undefined) {
      if (!Array.isArray(u.speakers)) return { error: `块 ${u.blockId}：speakers 必须是字符串数组。` };
      const resolved = resolveSpeakerRefs(u.speakers.map(String), state.characters);
      if (!resolved.ok) return { error: `块 ${u.blockId}：${resolved.error}（未做任何变更）` };
      speakers = resolved.speakers;
    }
    const merged = mergeStructured(original!, u, speakers);
    if ("error" in merged) return { error: `${merged.error}（未做任何变更）` };
    if (merged !== original) {
      summary.updated.push(u.blockId);
      nextBlocks = nextBlocks.map((b) => (b.id === u.blockId ? merged : b));
    } else {
      summary.retained += 1;
    }
  }

  for (const id of deletes) {
    const guard = markerGuard(byId.get(id), id);
    if (guard) return { error: guard };
    summary.deleted.push(id);
    nextBlocks = nextBlocks.filter((b) => b.id !== id);
  }

  for (const it of inserts) {
    if (!it || typeof it.afterBlockId !== "string" || !it.afterBlockId) return { error: "每个 insert 都必须带 afterBlockId（未做任何变更）。" };
    if (typeof it.content !== "string") return { error: "每个 insert 都必须带 content（未做任何变更）。" };
    const anchorIdx = nextBlocks.findIndex((b) => b.id === it.afterBlockId);
    if (anchorIdx < 0) {
      return { error: byId.has(it.afterBlockId)
        ? `插入锚点 ${it.afterBlockId} 在同一批里被删除了——换一个锚点（未做任何变更）。`
        : `没有找到插入锚点 ${it.afterBlockId}（未做任何变更）。` };
    }
    const type = it.type === "stage" ? "stage" : "dialogue";
    let speakers: ParsedSpeaker[] = [];
    if (it.speakers !== undefined) {
      if (type === "stage") return { error: "舞台提示块（type=stage）不能有说话人（未做任何变更）。" };
      if (!Array.isArray(it.speakers)) return { error: "insert 的 speakers 必须是字符串数组（未做任何变更）。" };
      const resolved = resolveSpeakerRefs(it.speakers.map(String), state.characters);
      if (!resolved.ok) return { error: `${resolved.error}（未做任何变更）` };
      speakers = resolved.speakers;
    }
    const fields = speakerFields(speakers);
    const block: Block = {
      id: randomUUID(),
      type,
      content: norm(it.content),
      stageComment: typeof it.stageComment === "string" && it.stageComment !== "" ? norm(it.stageComment) : null,
      characterIds: fields.characterIds,
      characterAnnotations: fields.characterAnnotations,
      lyric: type === "stage" ? false : it.lyric === true,
      sceneId: null,
      rehearsalMark: null,
    };
    summary.inserted.push(block.id);
    nextBlocks = [...nextBlocks.slice(0, anchorIdx + 1), block, ...nextBlocks.slice(anchorIdx + 1)];
  }

  // 归属重算跑全量（插入/删除会改变后续块的 marker 归属投影）
  const projected = withLegacyOwnershipProjection(withMarkerOwnership(nextBlocks));
  return finishPlan(ctx, productionId, state, projected, summary, `精修 ${total} 处`);
}

// ─── 统一执行 / 预览（与构作族同形，service preflight 与确认后执行共用） ────────

const PLANNERS: Record<string, (ctx: WriteCtx, pid: string, args: Record<string, unknown>) => Promise<Plan>> = {
  "production-script_propose_rewrite": (ctx, pid, a) => planRewrite(ctx, pid, a as RewriteArgs),
  "production-script_propose_edit_blocks": (ctx, pid, a) => planEditBlocks(ctx, pid, a as EditBlocksArgs),
};
export const SCRIPT_PROPOSE_TOOLS: ReadonlySet<string> = new Set(Object.keys(PLANNERS));

/** 写工具入口（确认门批准后调用）：规划 → 权限（安全边界）→ 执行。 */
export async function runScriptProposal(userId: string, productionId: string, bareTool: string, args: Record<string, unknown>): Promise<string> {
  const planner = PLANNERS[bareTool];
  if (!planner) return `未知的剧本写工具：${bareTool}`;
  const ctx = await writePrelude(userId, productionId);
  if (typeof ctx === "string") return ctx;
  const plan = await planner(ctx, productionId, args ?? {});
  if ("error" in plan) return plan.error;
  const checks = await checkNodes(ctx.actor, productionId, plan.wants);
  const blocked = checks.filter((c) => !c.result.allowed);
  if (blocked.length > 0) return denialText(blocked, productionId);
  return plan.run();
}

export type ScriptWritePreview = { hasPermission: boolean; notes: string[]; error?: string };

/** 确认卡片用的预览：与执行同一份规划与判定，只看不做。 */
export async function previewScriptProposal(userId: string, productionId: string, bareTool: string, args: Record<string, unknown>): Promise<ScriptWritePreview> {
  const planner = PLANNERS[bareTool];
  if (!planner) return { hasPermission: false, notes: [], error: `未知的剧本写工具：${bareTool}` };
  const ctx = await writePrelude(userId, productionId);
  if (typeof ctx === "string") return { hasPermission: false, notes: [], error: ctx };
  const plan = await planner(ctx, productionId, args ?? {});
  if ("error" in plan) return { hasPermission: false, notes: [], error: plan.error };
  const checks = await checkNodes(ctx.actor, productionId, plan.wants);
  const blocked = checks.filter((c) => !c.result.allowed);
  return {
    hasPermission: blocked.length === 0,
    notes: [...plan.notes, ...blocked.map((c) => describeBlockedKey(c, productionId))],
  };
}
