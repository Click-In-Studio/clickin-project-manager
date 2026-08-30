// 构作工具族（场次 + 角色）——production.* 族的一部分。
//
// 与 wiki 族的最大差别：**一个写工具横跨多把钥匙**。scene 的每个字段各有一把
// 钥匙（lib/scene-field-perms-shared：改名/改类型/梗概/行动线/音乐/舞台呈现/时长），
// 我们不可能给每个字段单独做一个工具，于是模型必须自己知道"我能改哪些"——否则
// 会一直碰壁。所以本族有一个显式的权限查询工具（dramaturgyPermissions），所有
// 写工具的描述都指向它："写之前先查"。它返回的是**三态**（六步链
// canAccessNodesBatch）：已持有 / 有资格未激活 / 需申请 / 无入口——比"有/无"多
// 出的那一态（有资格未激活）现在**不可写**，只告诉用户去页面激活（挂账：由 AI
// 触发自确认弹窗）。
//
// 门与 REST 逐条同源（app/api/production/[id]/scenes|characters）：
//   读：scene/*/meta@view（构作页门票） / character/*/meta@view（角色页门票）
//   场次字段：scene/*/<sub>@edit 逐字段；新建 scene/*@create；删除 scene/<id>@delete
//   （"whole" 连正文一起删还要 script/*/blocks@edit）
//   角色：character/*@create；character/<id>@edit；character/<id>@delete
// 批量提议一次卡、一次校验、一次 applyPatchToDB（版本级 advisory lock 串行化）——
// 任一项无权即整体不做，不静默丢弃无权的那几项（与 PATCH 路由"任一字段无权整体
// 403"同理）。
//
// 写工具流程：确认门批准 → 本文件函数再查一遍权限（真正的安全边界；preview 算出的
// hasPermission 只是给卡片看的）→ 落库 → 广播（场次页靠 markers SSE 自刷新；角色页
// 靠 agent mutation 行重拉）。

import { randomUUID } from "node:crypto";
import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import { neutralizeInjectionTags } from "@/lib/agent-injection-safety";
import { hasEffectiveGrant, type GrantActor } from "@/lib/grant-check";
import { canAccessNodesBatch, formatNodeKey, type NodeAccessResult, type NodeKeyParts } from "@/lib/grant-template";
import { SCENE_FIELD_SUBS, touchedSceneFields, type SceneField } from "@/lib/scene-field-perms-shared";
import { getSceneFieldPerms } from "@/lib/scene-field-perms";
import { getCharacterPerms } from "@/lib/character-perms";
import {
  getActiveVersionId, loadProduction, applyPatchToDB, listScenesByVersion, listMarkerProjectionByVersion,
  listCharactersByVersion, patchCharacterMeta, setCharacterMembers, type CharacterDetail,
} from "@/lib/db";
import { broadcastEvent, tickAndBroadcastSeq } from "@/lib/server-cache";
import { diffState } from "@/lib/script-ops";
import {
  convertMarker, executeMarkerDeletion, insertHierarchyMarker, planMarkerDeletion, resolveMarkerId, updateMarkerMeta,
  type MarkerDeleteOperation, type MarkerKind, type MarkerProjection,
} from "@/lib/script-marker-domain";
import type { ScriptState } from "@/lib/script-types";

// ─── 常量 / 文案 ───────────────────────────────────────────────────────────────

export const DENIED_SCENE_VIEW = "权限被拒绝：你没有查看场次目录的权限（需要 node:scene/*/meta@view）。";
export const DENIED_CHARACTER_VIEW = "权限被拒绝：你没有查看角色目录的权限（需要 node:character/*/meta@view）。";
const ARCHIVED = "该制作已归档，无法修改。";
const NO_VERSION = "该制作还没有剧本版本。";

/** 场次字段的中文名（与构作页表头一致） */
export const SCENE_FIELD_LABELS: Record<SceneField, string> = {
  name: "名称", kind: "类型（章/场）", synopsis: "梗概", actionLine: "行动线",
  music: "音乐", stageNotes: "舞台呈现", expectedDuration: "预计时长",
};
const SCENE_FIELD_ORDER: SceneField[] = ["name", "kind", "synopsis", "actionLine", "music", "stageNotes", "expectedDuration"];
const META_FIELDS = ["synopsis", "actionLine", "music", "stageNotes", "expectedDuration"] as const;

export const MAX_BATCH = 50;

const createId = () => randomUUID();

// ─── 权限：三态判定（六步链）────────────────────────────────────────────────────

type Want = { label: string; node: NodeKeyParts; page: "构作" | "角色" };
export type KeyCheck = Want & { key: string; result: NodeAccessResult };

async function checkNodes(actor: GrantActor, productionId: string, wants: Want[]): Promise<KeyCheck[]> {
  // 同一把钥匙在一批里可能被多项需要，去重后判一次
  const uniq = new Map<string, Want>();
  for (const w of wants) uniq.set(formatNodeKey(w.node), w);
  const list = [...uniq.entries()];
  const results = await canAccessNodesBatch(actor, productionId, list.map(([, w]) => w.node));
  return list.map(([key, w], i) => ({ ...w, key, result: results[i] }));
}

const applyUrl = (key: string, productionId: string) => `/unauthorized?resource=${encodeURIComponent(key)}&id=${productionId}`;

/** 一把未持有钥匙的说明（给模型转述给用户）。三态各有各的出路。 */
export function describeBlocked(c: KeyCheck, productionId: string): string {
  const r = c.result;
  if (r.allowed) return `✅ ${c.label}`;
  if (r.reason === "needs_self_confirm") {
    return `🔓 ${c.label}：你有这项权限的资格但尚未激活（${c.key}）——请到「${c.page}」页面点击激活提示，激活后再重试。`;
  }
  if (r.reason === "needs_approval") {
    return `📝 ${c.label}：需要申请（${c.key}），申请入口：${applyUrl(c.key, productionId)}`;
  }
  return `⛔ ${c.label}：没有申请入口（${c.key}）。`;
}

function denialText(blocked: KeyCheck[], productionId: string): string {
  return [
    "权限被拒绝，未做任何变更。缺少以下权限：",
    ...blocked.map((c) => `- ${describeBlocked(c, productionId)}`),
    "🔓=有资格待激活（用户到页面点一下即可）；📝=需走申请；⛔=无入口。",
  ].join("\n");
}

const sceneNode = (sub: string, verb: NodeKeyParts["verb"], id = "*"): NodeKeyParts => ({ resourceType: "scene", resourceId: id, resourceSub: sub, verb });
const charNode = (verb: NodeKeyParts["verb"], id = "*"): NodeKeyParts => ({ resourceType: "character", resourceId: id, resourceSub: "*", verb });

const SCENE_DOMAIN_WANTS: Want[] = [
  { label: "新建章节/场次", node: sceneNode("*", "create"), page: "构作" },
  ...SCENE_FIELD_ORDER.map((f): Want => ({ label: `修改${SCENE_FIELD_LABELS[f]}`, node: sceneNode(SCENE_FIELD_SUBS[f], "edit"), page: "构作" })),
  { label: "删除章节/场次（全部）", node: sceneNode("*", "delete"), page: "构作" },
];
const CHARACTER_DOMAIN_WANTS: Want[] = [
  { label: "新建角色", node: charNode("create"), page: "角色" },
  { label: "编辑角色（全部）", node: charNode("edit"), page: "角色" },
  { label: "删除角色（全部）", node: charNode("delete"), page: "角色" },
];

function stateIcon(r: NodeAccessResult): string {
  if (r.allowed) return "✅";
  if (r.reason === "needs_self_confirm") return "🔓";
  if (r.reason === "needs_approval") return "📝";
  return "⛔";
}

/** production.dramaturgy_permissions：我在构作域（场次/角色）能写什么——三态清单。 */
export async function dramaturgyPermissions(userId: string, productionId: string): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  const { actor } = resolved;
  const bypass = actor.isAdmin || actor.isOwner;

  const [checks, scenePerms, charPerms] = await Promise.all([
    checkNodes(actor, productionId, [...SCENE_DOMAIN_WANTS, ...CHARACTER_DOMAIN_WANTS]),
    getSceneFieldPerms(userId, productionId, bypass),
    getCharacterPerms(userId, productionId, bypass),
  ]);
  const line = (c: KeyCheck) => `- ${stateIcon(c.result)} ${c.label}${c.result.allowed ? "" : `（${c.key}）`}`;
  const sceneChecks = checks.filter((c) => c.node.resourceType === "scene");
  const charChecks = checks.filter((c) => c.node.resourceType === "character");

  const lines: string[] = [
    resolved.isArchived ? "⚠️ 该制作已归档：以下写权限全部不可用。" : null,
    bypass ? "（你是所有者/管理员：构作域全部可写）" : null,
    "## 场次（构作视图）",
    ...sceneChecks.map(line),
    scenePerms.deleteIds.length > 0 ? `- 另对以下场次单独持有删除权：${scenePerms.deleteIds.join("、")}` : null,
    "",
    "## 角色",
    ...charChecks.map(line),
    charPerms.editIds.length > 0 ? `- 另可单独编辑这些角色：${charPerms.editIds.join("、")}` : null,
    charPerms.deleteIds.length > 0 ? `- 另可单独删除这些角色：${charPerms.deleteIds.join("、")}` : null,
    "",
    "图例：✅ 已持有，可直接提议；🔓 有资格但未激活——不可写，请用户到对应页面点击激活提示；📝 需申请（入口 /unauthorized?resource=<键>&id=<制作 id>）；⛔ 无申请入口。",
    "提议时只包含 ✅ 的字段/动作；一次提议里任一项无权限，整批都不会执行。",
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

// ─── 读 ───────────────────────────────────────────────────────────────────────

/** 读门：通过返回 null，拒绝返回给模型的文案（与 memberGate 同形）。 */
async function sceneReadGate(userId: string, productionId: string): Promise<string | null> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (!await hasEffectiveGrant(resolved.actor, productionId, "scene", "*", "meta", "view")) return DENIED_SCENE_VIEW;
  return null;
}

async function characterReadGate(userId: string, productionId: string): Promise<string | null> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (!await hasEffectiveGrant(resolved.actor, productionId, "character", "*", "meta", "view")) return DENIED_CHARACTER_VIEW;
  return null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const kindLabel = (k: MarkerKind) => (k === "chapter" ? "章" : "场");

function detailLines(s: MarkerProjection, indent: string, cap: number): string[] {
  const out: string[] = [];
  for (const f of META_FIELDS) {
    const v = s[f];
    if (typeof v === "string" && v.trim()) out.push(`${indent}${SCENE_FIELD_LABELS[f]}：${clip(v.trim().replace(/\s*\n+\s*/g, " / "), cap)}`);
  }
  return out;
}

/** 章→场 两级树；父不可解析的场落到根层（不静默丢弃，同 wiki 树）。 */
function sceneTree(scenes: MarkerProjection[]): Array<{ scene: MarkerProjection; depth: number }> {
  const ids = new Set(scenes.map((s) => s.id));
  const byParent = new Map<string | null, MarkerProjection[]>();
  for (const s of scenes) {
    const key = s.kind === "scene" && s.parentId && ids.has(s.parentId) ? s.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), s]);
  }
  const out: Array<{ scene: MarkerProjection; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of byParent.get(parent) ?? []) {
      out.push({ scene: s, depth });
      if (s.kind === "chapter") walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export async function sceneList(userId: string, productionId: string, opts: { withDetails?: boolean } = {}): Promise<string> {
  const denied = await sceneReadGate(userId, productionId);
  if (denied) return denied;
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return NO_VERSION;
  const scenes = await listMarkerProjectionByVersion(versionId);
  if (scenes.length === 0) return "（该制作还没有章节/场次）";

  const lines: string[] = [];
  for (const { scene: s, depth } of sceneTree(scenes)) {
    const indent = "  ".repeat(depth);
    const extras = [
      s.expectedDuration ? `时长 ${s.expectedDuration}` : null,
      s.rehearsalMarks.length > 0 ? `排练标记 ${s.rehearsalMarks.length}` : null,
    ].filter(Boolean);
    lines.push(`${indent}- 【${kindLabel(s.kind)}】${s.number ? `${s.number} ` : ""}${s.name || "（未命名）"}（id: ${s.id}）${extras.length ? `｜${extras.join("｜")}` : ""}`);
    if (opts.withDetails) lines.push(...detailLines(s, `${indent}    `, 120));
  }
  // 名称/梗概是成员可写的自由文本——回给模型前中和注入分隔符（同 wiki）
  return neutralizeInjectionTags(lines.join("\n"));
}

export async function sceneRead(userId: string, productionId: string, sceneId: string): Promise<string> {
  const denied = await sceneReadGate(userId, productionId);
  if (denied) return denied;
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return NO_VERSION;
  const scenes = await listMarkerProjectionByVersion(versionId);
  const s = scenes.find((x) => x.id === sceneId);
  if (!s) return "没有找到该章节/场次。";
  const parent = s.parentId ? scenes.find((x) => x.id === s.parentId) : null;
  const children = s.kind === "chapter" ? scenes.filter((x) => x.kind === "scene" && x.parentId === s.id) : [];
  const details = detailLines(s, "", 2000);
  const lines = [
    `【${kindLabel(s.kind)}】${s.number ? `${s.number} ` : ""}${s.name || "（未命名）"}（id: ${s.id}）`,
    parent ? `所属章节：${parent.name || "（未命名）"}（id: ${parent.id}）` : null,
    ...(details.length > 0 ? details : ["（构作字段均为空）"]),
    s.rehearsalMarks.length > 0 ? `排练标记：${s.rehearsalMarks.join("、")}` : null,
    children.length > 0 ? `下辖场次：\n${children.map((c) => `- ${c.number ? `${c.number} ` : ""}${c.name || "（未命名）"}（id: ${c.id}）`).join("\n")}` : null,
  ].filter((l): l is string => l !== null);
  return neutralizeInjectionTags(lines.join("\n"));
}

function characterLine(c: CharacterDetail, nameOf: Map<string, string>, bioCap: number): string {
  const parts = [`- ${c.name}（id: ${c.id}）`];
  parts.push(c.isAggregate ? `聚合角色：${c.memberIds.length > 0 ? c.memberIds.map((id) => nameOf.get(id) ?? id).join("、") : "（无成员）"}` : "单人角色");
  if (c.roleType) parts.push(`类型 ${c.roleType}`);
  if (c.gender) parts.push(`性别 ${c.gender}`);
  if (c.biography?.trim()) parts.push(`小传：${clip(c.biography.trim().replace(/\s*\n+\s*/g, " / "), bioCap)}`);
  return parts.join("｜");
}

export async function characterList(userId: string, productionId: string): Promise<string> {
  const denied = await characterReadGate(userId, productionId);
  if (denied) return denied;
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return NO_VERSION;
  const chars = await listCharactersByVersion(versionId);
  if (chars.length === 0) return "（该制作还没有角色）";
  const nameOf = new Map(chars.map((c) => [c.id, c.name]));
  return neutralizeInjectionTags(chars.map((c) => characterLine(c, nameOf, 60)).join("\n"));
}

export async function characterRead(userId: string, productionId: string, charId: string): Promise<string> {
  const denied = await characterReadGate(userId, productionId);
  if (denied) return denied;
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return NO_VERSION;
  const chars = await listCharactersByVersion(versionId);
  const c = chars.find((x) => x.id === charId);
  if (!c) return "没有找到该角色。";
  const nameOf = new Map(chars.map((x) => [x.id, x.name]));
  const lines = [
    `${c.name}（id: ${c.id}）${c.isAggregate ? "［聚合角色］" : ""}`,
    c.isAggregate ? `成员：${c.memberIds.length > 0 ? c.memberIds.map((id) => `${nameOf.get(id) ?? id}（id: ${id}）`).join("、") : "（无）"}` : null,
    `角色类型：${c.roleType || "（未填）"}`,
    `性别：${c.gender || "（未填）"}`,
    `人物小传：${c.biography?.trim() ? `\n${c.biography.trim()}` : "（未填）"}`,
  ].filter((l): l is string => l !== null);
  return neutralizeInjectionTags(lines.join("\n"));
}

// ─── 写：前置 ─────────────────────────────────────────────────────────────────

type WriteCtx = { actor: GrantActor; versionId: string };

async function writePrelude(userId: string, productionId: string): Promise<WriteCtx | string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return ARCHIVED;
  // 写只落 head（rejectNonHeadWrite 的线性化不变量）：工具没有 versionId 参数，永远取活跃版本
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return NO_VERSION;
  return { actor: resolved.actor, versionId };
}

async function loadState(productionId: string, versionId: string): Promise<ScriptState | null> {
  return (await loadProduction(productionId, versionId))?.state ?? null;
}

function broadcastMarkers(productionId: string, versionId: string): void {
  const seq = tickAndBroadcastSeq(productionId, versionId);
  broadcastEvent(productionId, versionId, "markers", { seq });
}

/** 一次提议的规划结果：要么有错（参数/业务规则，不是权限），要么给出需要的钥匙 + 执行闭包。 */
type Plan =
  | { error: string }
  | { wants: Want[]; notes: string[]; run: () => Promise<string> };

// ─── 场次：修改（批量）──────────────────────────────────────────────────────────

export type SceneUpdateItem = {
  sceneId: string;
  name?: string;
  kind?: MarkerKind;
  synopsis?: string;
  actionLine?: string;
  music?: string;
  stageNotes?: string;
  expectedDuration?: string;
};

function sceneLabel(scenes: MarkerProjection[], id: string): string {
  const s = scenes.find((x) => x.id === id);
  return s ? `${s.number ? `${s.number} ` : ""}${s.name || "（未命名）"}` : id;
}

async function planSceneUpdate(ctx: WriteCtx, productionId: string, updates: SceneUpdateItem[]): Promise<Plan> {
  if (!Array.isArray(updates) || updates.length === 0) return { error: "updates 为空，未做任何变更。" };
  if (updates.length > MAX_BATCH) return { error: `一次最多修改 ${MAX_BATCH} 个场次，请分批。` };
  const state = await loadState(productionId, ctx.versionId);
  if (!state) return { error: NO_VERSION };
  const scenes = await listMarkerProjectionByVersion(ctx.versionId);

  const touchedAll = new Set<SceneField>();
  const perItem: Array<{ id: string; fields: SceneField[] }> = [];
  for (const u of updates) {
    if (!u || typeof u.sceneId !== "string" || !u.sceneId) return { error: "每一项都必须带 sceneId。" };
    if (!resolveMarkerId(state, u.sceneId)) return { error: `没有找到场次 ${u.sceneId}，未做任何变更。` };
    const fields = touchedSceneFields(u as Record<string, unknown>);
    if (fields.length === 0) return { error: `场次 ${u.sceneId} 没有提供任何要修改的字段（kind 只能是 chapter 或 scene，其余字段须为字符串）。` };
    if (typeof u.name === "string" && !u.name.trim()) return { error: `场次 ${u.sceneId} 的名称不能为空。` };
    fields.forEach((f) => touchedAll.add(f));
    perItem.push({ id: u.sceneId, fields });
  }
  const wants = SCENE_FIELD_ORDER.filter((f) => touchedAll.has(f))
    .map((f): Want => ({ label: `修改${SCENE_FIELD_LABELS[f]}`, node: sceneNode(SCENE_FIELD_SUBS[f], "edit"), page: "构作" }));
  const notes = perItem.map((p) => `${sceneLabel(scenes, p.id)}：${p.fields.map((f) => SCENE_FIELD_LABELS[f]).join("/")}`);

  return {
    wants, notes,
    run: async () => {
      let next = state;
      for (const u of updates) {
        // 与 PATCH 路由同序：先换类型再写字段（换类型后 id 仍可经 resolveMarkerId 解析）
        if (u.kind === "chapter" || u.kind === "scene") next = convertMarker(next, u.sceneId, u.kind, createId);
        const fields: Record<string, string> = {};
        if (typeof u.name === "string") fields.name = u.name.trim();
        for (const k of META_FIELDS) if (typeof u[k] === "string") fields[k] = u[k] as string;
        if (Object.keys(fields).length > 0) next = updateMarkerMeta(next, u.sceneId, fields);
      }
      const patch = diffState(state, next, 0);
      if (patch.blockOps.length === 0 && patch.sceneOps.length === 0) return "内容与现状相同，未做变更。";
      await applyPatchToDB(productionId, ctx.versionId, patch);
      broadcastMarkers(productionId, ctx.versionId);
      return `已更新 ${perItem.length} 个章节/场次：\n${notes.map((n) => `- ${n}`).join("\n")}`;
    },
  };
}

// ─── 场次：新建（批量）──────────────────────────────────────────────────────────

export type SceneCreateItem = {
  name: string;
  kind?: MarkerKind;
  parentId?: string;
  insertBeforeSceneId?: string;
  insertAfterSceneId?: string;
};

async function planSceneCreate(ctx: WriteCtx, productionId: string, items: SceneCreateItem[]): Promise<Plan> {
  if (!Array.isArray(items) || items.length === 0) return { error: "items 为空，未做任何变更。" };
  if (items.length > MAX_BATCH) return { error: `一次最多新建 ${MAX_BATCH} 个，请分批。` };
  const state = await loadState(productionId, ctx.versionId);
  if (!state) return { error: NO_VERSION };
  for (const it of items) {
    if (!it || typeof it.name !== "string" || !it.name.trim()) return { error: "每一项都必须有非空的 name。" };
    for (const ref of [it.parentId, it.insertBeforeSceneId, it.insertAfterSceneId]) {
      if (ref !== undefined && (typeof ref !== "string" || !resolveMarkerId(state, ref))) return { error: `引用的章节/场次不存在：${ref}` };
    }
  }
  // 与 POST 路由同口径：带 parentId 或 kind=scene 即为场，否则为章
  const kindOf = (it: SceneCreateItem): MarkerKind => (it.kind === "scene" || it.parentId ? "scene" : "chapter");
  const notes = items.map((it) => `【${kindLabel(kindOf(it))}】${it.name.trim()}${it.parentId ? `（父：${it.parentId}）` : ""}`);
  return {
    wants: [{ label: "新建章节/场次", node: sceneNode("*", "create"), page: "构作" }],
    notes,
    run: async () => {
      let next = state;
      const created: Array<{ id: string; kind: MarkerKind; name: string }> = [];
      for (const it of items) {
        // insertMarker 的第一次 createId() 就是标记本身的 id（其后的调用是规范化补的空块）
        let first: string | null = null;
        const capture = () => { const id = createId(); if (!first) first = id; return id; };
        next = insertHierarchyMarker(next, {
          kind: kindOf(it), name: it.name.trim(),
          parentId: it.parentId ?? null,
          beforeId: it.insertBeforeSceneId ?? null,
          afterId: it.insertAfterSceneId ?? null,
        }, capture);
        created.push({ id: first!, kind: kindOf(it), name: it.name.trim() });
      }
      await applyPatchToDB(productionId, ctx.versionId, diffState(state, next, 0));
      broadcastMarkers(productionId, ctx.versionId);
      return `已新建 ${created.length} 个章节/场次：\n${created.map((c) => `- 【${kindLabel(c.kind)}】${c.name}（id: ${c.id}）`).join("\n")}`;
    },
  };
}

// ─── 场次：删除（单个；删除方式可能需要用户选择）───────────────────────────────────

export type SceneDeleteArgs = { sceneId: string; operation?: "marker-only" | "whole" };

async function planSceneDelete(ctx: WriteCtx, productionId: string, args: SceneDeleteArgs): Promise<Plan> {
  if (typeof args.sceneId !== "string" || !args.sceneId) return { error: "必须提供 sceneId。" };
  const state = await loadState(productionId, ctx.versionId);
  if (!state) return { error: NO_VERSION };
  if (!resolveMarkerId(state, args.sceneId)) return { error: "没有找到该章节/场次。" };
  const details = await listScenesByVersion(ctx.versionId);
  const plan = planMarkerDeletion(state, args.sceneId, details);
  // 业务规则拦截（不是权限问题）：与 DELETE 路由的 409 同义
  if (plan.status === "blocked") return { error: `无法删除：${plan.message}（这不是权限问题）` };
  if (plan.status === "choice" && !args.operation) {
    return {
      error: [
        "该章节下还有内容，删除方式需要用户选择（未做任何变更）：",
        "- marker-only：只删除这个章节标记，其下的场次/正文并入前一个章节；",
        `- whole：连同其下全部 ${Math.max(plan.previewBlockIds.length - 1, 0)} 个内容块一起删除（需要剧本编辑权限）。`,
        "请用 ask_user 让用户二选一，然后带 operation 参数重新调用本工具。",
      ].join("\n"),
    };
  }
  const operation: MarkerDeleteOperation = plan.status === "ready"
    ? plan.operation
    : { type: args.operation === "whole" ? "whole" : "marker-only", markerId: args.sceneId };
  const wants: Want[] = [{ label: "删除该章节/场次", node: sceneNode("*", "delete", args.sceneId), page: "构作" }];
  if (operation.type === "whole") {
    wants.push({ label: "删除其下正文（剧本编辑）", node: { resourceType: "script", resourceId: "*", resourceSub: "blocks", verb: "edit" }, page: "构作" });
  }
  const scenes = await listMarkerProjectionByVersion(ctx.versionId);
  const notes = [
    `目标：${sceneLabel(scenes, args.sceneId)}`,
    operation.type === "whole"
      ? `方式：连同其下 ${Math.max(plan.previewBlockIds.length - 1, 0)} 个内容块一起删除`
      : "方式：只删标记，其下内容并入前一章节/场次",
  ];
  return {
    wants, notes,
    run: async () => {
      const next = executeMarkerDeletion(state, operation, createId);
      await applyPatchToDB(productionId, ctx.versionId, diffState(state, next, 0));
      broadcastMarkers(productionId, ctx.versionId);
      return `已删除 ${notes[0].slice(3)}（${operation.type === "whole" ? "连同其下内容" : "仅标记"}）。`;
    },
  };
}

// ─── 角色：新建（批量）──────────────────────────────────────────────────────────

export type CharacterCreateItem = { name: string; isAggregate?: boolean; memberIds?: string[] };

async function planCharacterCreate(ctx: WriteCtx, productionId: string, items: CharacterCreateItem[]): Promise<Plan> {
  if (!Array.isArray(items) || items.length === 0) return { error: "items 为空，未做任何变更。" };
  if (items.length > MAX_BATCH) return { error: `一次最多新建 ${MAX_BATCH} 个角色，请分批。` };
  const existing = await listCharactersByVersion(ctx.versionId);
  const taken = new Set(existing.map((c) => c.name));
  const nonAggregate = new Set(existing.filter((c) => !c.isAggregate).map((c) => c.id));
  const seen = new Set<string>();
  for (const it of items) {
    const name = typeof it?.name === "string" ? it.name.trim() : "";
    if (!name) return { error: "每个角色都必须有非空的 name。" };
    if (taken.has(name)) return { error: `角色名已存在：${name}（未做任何变更）` };
    if (seen.has(name)) return { error: `同一批里角色名重复：${name}（未做任何变更）` };
    seen.add(name);
    for (const m of it.memberIds ?? []) {
      if (!nonAggregate.has(m)) return { error: `聚合成员 ${m} 不是本制作的单人角色（未做任何变更）` };
    }
  }
  const notes = items.map((it) => `${it.name.trim()}${it.isAggregate ? "（聚合角色）" : ""}`);
  return {
    wants: [{ label: "新建角色", node: charNode("create"), page: "角色" }],
    notes,
    run: async () => {
      // 与 POST 路由同一 id 形态（c + base36）；批内加随机尾防同毫秒撞车
      const chars = items.map((it) => ({
        id: `c${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
        name: it.name.trim(),
        isAggregate: it.isAggregate === true,
        memberIds: it.isAggregate === true ? (it.memberIds ?? []).filter((m) => typeof m === "string") : [],
      }));
      await applyPatchToDB(productionId, ctx.versionId, {
        clientSeq: 0, blockOps: [], sceneOps: [],
        charOps: chars.map((c) => ({ op: "upsert", char: { id: c.id, name: c.name, isAggregate: c.isAggregate } })),
      });
      tickAndBroadcastSeq(productionId, ctx.versionId);
      for (const c of chars) if (c.isAggregate && c.memberIds.length > 0) await setCharacterMembers(productionId, c.id, c.memberIds);
      return `已新建 ${chars.length} 个角色：\n${chars.map((c) => `- ${c.name}（id: ${c.id}）${c.isAggregate ? "［聚合］" : ""}`).join("\n")}`;
    },
  };
}

// ─── 角色：修改（批量）──────────────────────────────────────────────────────────

export type CharacterUpdateItem = {
  charId: string;
  name?: string;
  isAggregate?: boolean;
  memberIds?: string[];
  gender?: string;
  biography?: string;
  roleType?: string;
};

async function planCharacterUpdate(ctx: WriteCtx, productionId: string, updates: CharacterUpdateItem[]): Promise<Plan> {
  if (!Array.isArray(updates) || updates.length === 0) return { error: "updates 为空，未做任何变更。" };
  if (updates.length > MAX_BATCH) return { error: `一次最多修改 ${MAX_BATCH} 个角色，请分批。` };
  const existing = await listCharactersByVersion(ctx.versionId);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const nonAggregate = new Set(existing.filter((c) => !c.isAggregate).map((c) => c.id));
  const notes: string[] = [];
  const wants: Want[] = [];
  for (const u of updates) {
    const cur = typeof u?.charId === "string" ? byId.get(u.charId) : undefined;
    if (!cur) return { error: `没有找到角色 ${u?.charId}，未做任何变更。` };
    const changed: string[] = [];
    if (typeof u.name === "string") { if (!u.name.trim()) return { error: `角色 ${cur.name} 的名称不能为空。` }; changed.push("名称"); }
    if (typeof u.isAggregate === "boolean") changed.push("聚合/单人");
    if (Array.isArray(u.memberIds)) {
      for (const m of u.memberIds) if (!nonAggregate.has(m) || m === cur.id) return { error: `聚合成员 ${m} 不是本制作的单人角色（未做任何变更）` };
      changed.push("聚合成员");
    }
    if (typeof u.gender === "string") changed.push("性别");
    if (typeof u.biography === "string") changed.push("小传");
    if (typeof u.roleType === "string") changed.push("类型");
    if (changed.length === 0) return { error: `角色 ${cur.name} 没有提供任何要修改的字段。` };
    notes.push(`${cur.name}：${changed.join("/")}`);
    wants.push({ label: `编辑角色「${cur.name}」`, node: charNode("edit", cur.id), page: "角色" });
  }
  return {
    wants, notes,
    run: async () => {
      // 与 PATCH 路由同一份落库路径：结构字段走 patch、meta 直写、成员集整体替换
      const charOps: Array<{ op: "upsert"; char: { id: string; name: string; isAggregate: boolean } }> = [];
      const memberSets: Array<[string, string[]]> = [];
      for (const u of updates) {
        const cur = byId.get(u.charId)!;
        const nextAggregate = typeof u.isAggregate === "boolean" ? u.isAggregate : cur.isAggregate;
        if (typeof u.name === "string" || typeof u.isAggregate === "boolean") {
          charOps.push({ op: "upsert", char: { id: cur.id, name: typeof u.name === "string" ? u.name.trim() : cur.name, isAggregate: nextAggregate } });
        }
        if (typeof u.isAggregate === "boolean" && u.isAggregate !== cur.isAggregate) memberSets.push([cur.id, []]);
        if (Array.isArray(u.memberIds)) memberSets.push([cur.id, nextAggregate ? u.memberIds : []]);
        const meta: { gender?: string; biography?: string; roleType?: string } = {};
        if (typeof u.gender === "string") meta.gender = u.gender;
        if (typeof u.biography === "string") meta.biography = u.biography;
        if (typeof u.roleType === "string") meta.roleType = u.roleType;
        if (Object.keys(meta).length > 0) await patchCharacterMeta(cur.id, ctx.versionId, meta);
      }
      if (charOps.length > 0) await applyPatchToDB(productionId, ctx.versionId, { clientSeq: 0, blockOps: [], sceneOps: [], charOps });
      for (const [id, members] of memberSets) await setCharacterMembers(productionId, id, members);
      tickAndBroadcastSeq(productionId, ctx.versionId);
      return `已更新 ${updates.length} 个角色：\n${notes.map((n) => `- ${n}`).join("\n")}`;
    },
  };
}

// ─── 角色：删除（批量）──────────────────────────────────────────────────────────

async function planCharacterDelete(ctx: WriteCtx, productionId: string, charIds: string[]): Promise<Plan> {
  if (!Array.isArray(charIds) || charIds.length === 0) return { error: "charIds 为空，未做任何变更。" };
  if (charIds.length > MAX_BATCH) return { error: `一次最多删除 ${MAX_BATCH} 个角色，请分批。` };
  const existing = await listCharactersByVersion(ctx.versionId);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const targets = [...new Set(charIds)].map((id) => byId.get(id));
  const missing = charIds.filter((id) => !byId.has(id));
  if (missing.length > 0) return { error: `没有找到角色：${missing.join("、")}（未做任何变更）` };
  const list = targets as CharacterDetail[];
  return {
    wants: list.map((c): Want => ({ label: `删除角色「${c.name}」`, node: charNode("delete", c.id), page: "角色" })),
    notes: list.map((c) => c.name),
    run: async () => {
      await applyPatchToDB(productionId, ctx.versionId, {
        clientSeq: 0, blockOps: [], sceneOps: [],
        charOps: list.map((c) => ({ op: "delete", id: c.id })),
      });
      tickAndBroadcastSeq(productionId, ctx.versionId);
      return `已删除 ${list.length} 个角色：${list.map((c) => c.name).join("、")}。`;
    },
  };
}

// ─── 统一执行 / 预览 ──────────────────────────────────────────────────────────

/** 去前缀暴露名（production-scene_propose_update 等）→ 规划函数 */
const PLANNERS: Record<string, (ctx: WriteCtx, pid: string, args: Record<string, unknown>) => Promise<Plan>> = {
  "production-scene_propose_update": (ctx, pid, a) => planSceneUpdate(ctx, pid, a.updates as SceneUpdateItem[]),
  "production-scene_propose_create": (ctx, pid, a) => planSceneCreate(ctx, pid, a.items as SceneCreateItem[]),
  "production-scene_propose_delete": (ctx, pid, a) => planSceneDelete(ctx, pid, a as SceneDeleteArgs),
  "production-character_propose_create": (ctx, pid, a) => planCharacterCreate(ctx, pid, a.items as CharacterCreateItem[]),
  "production-character_propose_update": (ctx, pid, a) => planCharacterUpdate(ctx, pid, a.updates as CharacterUpdateItem[]),
  "production-character_propose_delete": (ctx, pid, a) => planCharacterDelete(ctx, pid, a.charIds as string[]),
};
export const DRAMATURGY_PROPOSE_TOOLS: ReadonlySet<string> = new Set(Object.keys(PLANNERS));

/** 写工具入口（确认门批准后调用）：规划 → 权限（安全边界）→ 执行。 */
export async function runDramaturgyProposal(userId: string, productionId: string, bareTool: string, args: Record<string, unknown>): Promise<string> {
  const planner = PLANNERS[bareTool];
  if (!planner) return `未知的构作工具：${bareTool}`;
  const ctx = await writePrelude(userId, productionId);
  if (typeof ctx === "string") return ctx;
  const plan = await planner(ctx, productionId, args ?? {});
  if ("error" in plan) return plan.error;
  const checks = await checkNodes(ctx.actor, productionId, plan.wants);
  const blocked = checks.filter((c) => !c.result.allowed);
  if (blocked.length > 0) return denialText(blocked, productionId);
  return plan.run();
}

export type DramaturgyPreview = { hasPermission: boolean; notes: string[]; error?: string };

/** 确认卡片用的预览：与执行同一份规划与判定，但只看不做。任何异常由调用方兜底（卡片照弹）。 */
export async function previewDramaturgyProposal(userId: string, productionId: string, bareTool: string, args: Record<string, unknown>): Promise<DramaturgyPreview> {
  const planner = PLANNERS[bareTool];
  if (!planner) return { hasPermission: false, notes: [], error: `未知的构作工具：${bareTool}` };
  const ctx = await writePrelude(userId, productionId);
  if (typeof ctx === "string") return { hasPermission: false, notes: [], error: ctx };
  const plan = await planner(ctx, productionId, args ?? {});
  if ("error" in plan) return { hasPermission: false, notes: [], error: plan.error };
  const checks = await checkNodes(ctx.actor, productionId, plan.wants);
  const blocked = checks.filter((c) => !c.result.allowed);
  return {
    hasPermission: blocked.length === 0,
    notes: [...plan.notes, ...blocked.map((c) => describeBlocked(c, productionId))],
  };
}
