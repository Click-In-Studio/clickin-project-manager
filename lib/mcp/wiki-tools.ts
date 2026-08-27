// wiki.* 项目工具——production.* 族的一部分（门 = 成员资格 + 实例级可见性，
// 复用 production-tools.ts 的 resolveProductionActor/DENIED_NOT_MEMBER）。
// 语法方言声明见 ./wiki-link-syntax（教会模型别瞎发明 [[标题]] 语法）。

import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import {
  listWikiLibrary, getWiki, listBacklinks, listOutgoingLinks, searchWiki,
  extractWikiLinkTargets, createWiki, updateWiki, deleteWiki,
  setWikiPublic, setWikiDeptShares, listWikiDeptShares,
  listWikiSharePeople, addWikiSharePerson, removeWikiSharePerson,
  type WikiListEntry, type WikiRef,
} from "@/lib/wiki-db";
import {
  canViewWiki, canEditWiki, canDeleteWiki, canShareWiki,
  listVisibleWikiIds, listEnumerableWikiIds,
} from "@/lib/wiki-perm";
import { neutralizeInjectionTags } from "@/lib/agent-injection-safety";
import { listProductionDepts } from "@/lib/dept-db";
import { listProductionMembers } from "@/lib/db";
import type { WikiLevel } from "@/lib/resource-grant-db";
import { broadcastWikiUpdate } from "@/lib/wiki-collab";
import { hasEffectiveGrant, type GrantActor } from "@/lib/grant-check";
import { getPool } from "@/lib/pg";
import {
  getWikiProposalByToolCallId,
  markWikiProposalApplied, markWikiProposalBlocked,
} from "@/lib/wiki-proposal-db";

const DENIED_NOT_VISIBLE = "权限被拒绝：你看不到这篇文档。";
/** wiki 创建门的 node 权限键（域级，不带具体 id）——AccessRequestModal 的
 *  permission prop 用同一字符串锁定表单。 */
export const CREATE_PERMISSION_KEY = "node:wiki/*@create";
/** 编辑/删除门是实例级的——权限键要点名具体 wikiId。 */
export function editPermissionKey(wikiId: string): string { return `node:wiki/${wikiId}@edit`; }
export function deletePermissionKey(wikiId: string): string { return `node:wiki/${wikiId}@delete`; }
/** 分享面走保留段 grants@edit（'*' 不覆盖），键形如 node:wiki/<id>/grants@edit。 */
export function sharePermissionKey(wikiId: string): string { return `node:wiki/${wikiId}/grants@edit`; }

// ─── wiki.tree ──────────────────────────────────────────────────────────────

/** 嵌套缩进文本；孤儿节点（父文档因权限被过滤掉）落到根层，镜像
 *  components/wiki/WikiShell.tsx 的 byParent 邻接表兜底逻辑（不静默丢弃）。 */
function buildTreeText(entries: WikiListEntry[]): string {
  if (entries.length === 0) return "（该项目还没有文档，或你还看不到任何文档）";
  const ids = new Set(entries.map((e) => e.id));
  const byParent = new Map<string | null, WikiListEntry[]>();
  for (const e of entries) {
    const key = e.parentId && ids.has(e.parentId) ? e.parentId : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(e);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.sortKey ?? "").localeCompare(b.sortKey ?? ""));
  }
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const e of byParent.get(parentId) ?? []) {
      const tagStr = e.tags.length > 0 ? `［${e.tags.join("、")}］` : "";
      lines.push(`${"  ".repeat(depth)}- ${e.title ?? "（无标题）"}（id: ${e.id}）${tagStr}`);
      walk(e.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

async function filterVisible<T extends { id: string }>(
  actor: GrantActor,
  productionId: string,
  rows: T[],
): Promise<T[]> {
  const { wildcard, ids } = await listVisibleWikiIds(actor, productionId);
  return wildcard ? rows : rows.filter((r) => ids.has(r.id));
}

async function filterEnumerable<T extends { id: string }>(
  actor: GrantActor,
  productionId: string,
  rows: T[],
): Promise<T[]> {
  const { wildcard, ids } = await listEnumerableWikiIds(actor, productionId);
  return wildcard ? rows : rows.filter((r) => ids.has(r.id));
}

/** 目录树＝枚举面（#357），与人类侧栏同门。AI 能列到 ≠ 能读——正文仍过
 *  canViewWiki（#333 不变量 2：分层≠权限，工具端实时判定是唯一安全边界）。 */
export async function wikiTree(userId: string, productionId: string): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  const all = await listWikiLibrary(productionId);
  const visible = await filterEnumerable(resolved.actor, productionId, all);
  // 文档标题/正文是成员可写的自由文本——读回给模型前中和注入分隔符，防有人
  // 在文档里塞 <clickin-instructions> 之类经工具结果做间接注入。
  return neutralizeInjectionTags(buildTreeText(visible));
}

// ─── wiki.backlinks ─────────────────────────────────────────────────────────

function formatRefs(rows: WikiRef[]): string {
  return rows.length === 0
    ? "（无）"
    : rows.map((r) => `- ${r.title ?? "（无标题）"}（id: ${r.id}）`).join("\n");
}

export async function wikiBacklinks(userId: string, productionId: string, wikiId: string): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (!await canViewWiki(resolved.actor, productionId, wikiId)) return DENIED_NOT_VISIBLE;

  const [incoming, outgoing] = await Promise.all([
    listBacklinks(wikiId, productionId),
    listOutgoingLinks(wikiId, productionId),
  ]);
  return neutralizeInjectionTags([
    "谁链接到它（backlinks）：",
    formatRefs(incoming),
    "",
    "它链接到谁（outgoing）：",
    formatRefs(outgoing),
  ].join("\n"));
}

// ─── wiki.read ──────────────────────────────────────────────────────────────

async function resolveLinkTitles(ids: string[], productionId: string): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const res = await getPool().query<{ id: string; title: string | null }>(
    `SELECT id::text AS id, title FROM wiki WHERE id = ANY($1::uuid[]) AND production_id = $2`,
    [ids, productionId],
  );
  return new Map(res.rows.map((r) => [r.id, r.title]));
}

const WIKI_TOKEN_RE = /\[#wiki:([0-9a-fA-F-]{36})\]/g;
const WIKI_MD_LINK_RE = /\[[^[\]]*\]\(\/__cm__\/wiki\/([0-9a-fA-F-]{36})(?:[?#][^)]*)?\)/g;
// 只读兼容：wiki_revision 历史正文不迁移
const WIKI_MD_LINK_V1_RE = /\[[^[\]]*\]\(\/__cm__wiki:([0-9a-fA-F-]{36})(?:[?&][^)]*)?\)/g;

/** 把正文里的 id 形态链接换成可读的 [[标题]]，仅用于本工具的可读性处理——
 *  不碰 wiki_link 边表。只替换 extractWikiLinkTargets 已识别的真实目标
 *  （它本身就是代码块安全的），代码块里的语法示例原样保留，不误标"已删除"。 */
function resolveBodyLinksForDisplay(body: string, titleMap: Map<string, string | null>, targetSet: Set<string>): string {
  const sub = (raw: string, id: string): string => {
    const lower = id.toLowerCase();
    if (!targetSet.has(lower)) return raw;
    const title = titleMap.get(lower);
    return title ? `[[${title}]]` : "[[已删除的文档]]";
  };
  return body
    .replace(WIKI_MD_LINK_RE, (m, id) => sub(m, id))
    .replace(WIKI_MD_LINK_V1_RE, (m, id) => sub(m, id))
    .replace(WIKI_TOKEN_RE, (m, id) => sub(m, id));
}

export async function wikiRead(userId: string, productionId: string, wikiId: string): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (!await canViewWiki(resolved.actor, productionId, wikiId)) return DENIED_NOT_VISIBLE;

  const doc = await getWiki(wikiId, productionId);
  if (!doc) return "没有找到该文档。";

  const targets = extractWikiLinkTargets(doc.body);
  const titleMap = await resolveLinkTitles(targets, productionId);
  const body = resolveBodyLinksForDisplay(doc.body, titleMap, new Set(targets));

  const lines = [
    `《${doc.title ?? "（无标题）"}》${doc.isPublic ? "（公开）" : ""}`,
    doc.tags.length > 0 ? `标签：${doc.tags.join("、")}` : null,
    "",
    body,
  ].filter((l): l is string => l !== null);
  // 标题/正文是成员可写的自由文本——中和注入分隔符再返回（间接注入防护）。
  return neutralizeInjectionTags(lines.join("\n"));
}

// ─── wiki.search ────────────────────────────────────────────────────────────

export async function wikiSearch(userId: string, productionId: string, query: string): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;

  const results = await searchWiki(productionId, query);
  const visible = await filterVisible(resolved.actor, productionId, results);
  return visible.length === 0 ? "（没有匹配的文档）" : neutralizeInjectionTags(formatRefs(visible));
}

// ─── wiki.propose_* ─────────────────────────────────────────────────────────
// 门控原则（project_ai_infra 记忆）：四个工具都只在插件确认门批准
// （allow-once）后才会真正被调用——这里再查一遍权限是真正的安全边界，不信任
// /wiki-proposal 预持久化时算出的 has_permission（那只是给确认卡片/预览
// modal 用的展示值）。create 门是域级（能不能新建，不看具体哪篇），
// update/delete/move 门是实例级（对这一篇具体文档有没有编辑/删除权限）。

export async function wikiProposeCreate(
  userId: string, productionId: string, toolCallId: string,
  args: { parentId?: string | null; title: string; body?: string; summary: string },
): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法新建文档。";

  const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
  const allowed = await hasEffectiveGrant(resolved.actor, productionId, "wiki", "*", "*", "create");

  if (!allowed) {
    if (proposal) await markWikiProposalBlocked(proposal.id, "blocked_no_permission");
    return "权限被拒绝：你没有在该制作新建文档的权限。已记录本次调用，需人工审批通过后才能重试。";
  }

  const doc = await createWiki({
    productionId, title: args.title, body: args.body ?? "",
    parentId: args.parentId ?? null, createdBy: userId, origin: "ai-proposed",
  });
  if (proposal) await markWikiProposalApplied(proposal.id, doc.id);
  return `已创建文档《${doc.title}》（id: ${doc.id}）。`;
}

export async function wikiProposeUpdate(
  userId: string, productionId: string, toolCallId: string,
  args: { wikiId: string; title?: string; body?: string; summary: string },
): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法修改文档。";

  const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
  const allowed = await canEditWiki(resolved.actor, productionId, args.wikiId);

  if (!allowed) {
    if (proposal) await markWikiProposalBlocked(proposal.id, "blocked_no_permission");
    return "权限被拒绝：你没有编辑这篇文档的权限。已记录本次调用，需人工审批通过后才能重试。";
  }
  if (args.title === undefined && args.body === undefined) {
    return "没有提供要修改的标题或正文，未做任何变更。";
  }

  const doc = await updateWiki(args.wikiId, productionId, { title: args.title, body: args.body, origin: "ai-proposed" }, userId);
  if (!doc) return "没有找到该文档。";
  if (proposal) await markWikiProposalApplied(proposal.id, doc.id);
  // 推给正开着这篇文档的编辑器（同 PATCH 路由的协作广播）。少了这一步，AI
  // 改完正文屏幕上纹丝不动：WikiDocClient 的 title/body 是 useState 初值，
  // router.refresh() 送来新 props 也不覆盖，非手动刷新不可。byClientId 传
  // null——发起方不是任何一个浏览器端，谁都不该自过滤掉这一帧。
  broadcastWikiUpdate(doc.id, {
    byClientId: null, title: doc.title, body: doc.body, updatedAt: doc.updatedAt,
  });
  return `已更新文档《${doc.title}》（id: ${doc.id}）。`;
}

export async function wikiProposeDelete(
  userId: string, productionId: string, toolCallId: string,
  args: { wikiId: string; summary: string },
): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法删除文档。";

  const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
  const allowed = await canDeleteWiki(resolved.actor, productionId, args.wikiId);

  if (!allowed) {
    if (proposal) await markWikiProposalBlocked(proposal.id, "blocked_no_permission");
    return "权限被拒绝：你没有删除这篇文档的权限。已记录本次调用，需人工审批通过后才能重试。";
  }

  const result = await deleteWiki(args.wikiId, productionId);
  if (!result.ok) {
    // 业务规则拦截，不是权限问题——proposal 标专门的状态，别让前端误显示
    // "去申请权限"入口（申请了也没用）。
    if (proposal) await markWikiProposalBlocked(proposal.id, "blocked_business_rule");
    if (result.reason === "mounted") return "该文档被挂载（报告/备注引用它），无法删除。";
    if (result.reason === "anchor") return "该文档是系统锚点目录（报告根/事件目录），无法删除。";
    return "没有找到该文档。";
  }
  // created_wiki_id 传 null——被删的文档已经不在 wiki 表里了，FK 没法指向它。
  if (proposal) await markWikiProposalApplied(proposal.id, null);
  return "已删除该文档。";
}

export async function wikiProposeMove(
  userId: string, productionId: string, toolCallId: string,
  args: { wikiId: string; newParentId?: string | null; summary: string },
): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法移动文档。";

  const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
  const allowed = await canEditWiki(resolved.actor, productionId, args.wikiId);

  if (!allowed) {
    if (proposal) await markWikiProposalBlocked(proposal.id, "blocked_no_permission");
    return "权限被拒绝：你没有编辑这篇文档的权限。已记录本次调用，需人工审批通过后才能重试。";
  }

  let doc;
  try {
    doc = await updateWiki(args.wikiId, productionId, { parentId: args.newParentId ?? null, origin: "ai-proposed" }, userId);
  } catch (err) {
    // validateParent 抛错（父不存在/成环）——不是权限问题，proposal 标业务规则状态。
    if (proposal) await markWikiProposalBlocked(proposal.id, "blocked_business_rule");
    return err instanceof Error ? err.message : "移动失败：目标父文档不合法。";
  }
  if (!doc) return "没有找到该文档。";
  if (proposal) await markWikiProposalApplied(proposal.id, doc.id);
  return args.newParentId
    ? `已把文档《${doc.title}》移动到新的父文档下。`
    : `已把文档《${doc.title}》移动到文档库根。`;
}

export async function wikiProposeTag(
  userId: string, productionId: string, toolCallId: string,
  args: { wikiId: string; tags: string[]; summary: string },
): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法修改文档标签。";

  const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
  const allowed = await canEditWiki(resolved.actor, productionId, args.wikiId);

  if (!allowed) {
    if (proposal) await markWikiProposalBlocked(proposal.id, "blocked_no_permission");
    return "权限被拒绝：你没有编辑这篇文档的权限。已记录本次调用，需人工审批通过后才能重试。";
  }

  // updateWiki 的 tags patch 是整体替换（先删全部再按新集合插入），不是增量
  // 追加——工具描述里也要把这点说清楚，别让模型以为传一个词就是"再加一个"。
  const doc = await updateWiki(args.wikiId, productionId, { tags: args.tags }, userId);
  if (!doc) return "没有找到该文档。";
  if (proposal) await markWikiProposalApplied(proposal.id, doc.id);
  // 同 update：标签也是 useState 初值，不推这一帧就得手动刷新才看得见
  broadcastWikiUpdate(doc.id, {
    byClientId: null, title: doc.title, body: doc.body, updatedAt: doc.updatedAt, tags: doc.tags,
  });
  return args.tags.length > 0
    ? `已把文档《${doc.title}》的标签设为：${args.tags.join("、")}。`
    : `已清空文档《${doc.title}》的标签。`;
}

// ─── wiki.set_grant（分享面写工具）───────────────────────────────────────────
// 门 = canShareWiki（保留段 grants@edit，'*' 不覆盖）——**不是** edit 门：能改
// 正文的人未必能改谁看得见。三个面与 share 路由同一份实现（lib/wiki-db 的
// setWikiPublic / setWikiDeptShares / addWikiSharePerson…），口径不许分叉。
//
// 与 propose 五兄弟的差别：这里不预持久化 wiki_proposal——参数都很短，确认
// 卡片装得下全文，没有"512 字符装不下"的问题；无权限时也不落审批行，直接
// 把权限键回给模型，由用户走 /unauthorized 申请。插件的 fail-closed 门控
// （非 readOnly → 确认门）照旧适用，本函数内的权限判定才是安全边界。

export type WikiSetGrantArgs = {
  wikiId: string;
  isPublic?: boolean;
  deptIds?: string[];
  addPeople?: { userId: string; level: WikiLevel }[];
  removePeopleUserIds?: string[];
  summary: string;
};

const SHARE_LEVELS: WikiLevel[] = ["view", "edit", "manage"];
const LEVEL_LABEL: Record<WikiLevel, string> = { view: "可阅读", edit: "可编辑", manage: "可管理" };

/** 改完之后把三个面回读成一段人类可读的现状，供模型复述给用户。 */
async function shareStateText(wikiId: string, productionId: string): Promise<string> {
  const [doc, deptIds, people, depts, members] = await Promise.all([
    getWiki(wikiId, productionId),
    listWikiDeptShares(wikiId),
    listWikiSharePeople(wikiId, productionId),
    listProductionDepts(productionId).catch(() => []),
    listProductionMembers(productionId),
  ]);
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const memberName = new Map(members.map((m) => [m.userId, m.name || "（未命名）"]));
  return [
    `当前分享设置（文档《${doc?.title ?? "（无标题）"}》）：`,
    `- 全体成员可见：${doc?.isPublic ? "是" : "否"}`,
    `- 分享给部门：${deptIds.length > 0 ? deptIds.map((id) => deptName.get(id) ?? id).join("、") : "（无）"}`,
    `- 单独分享给：${people.length > 0
      ? people.map((p) => `${memberName.get(p.userId) ?? p.userId}（${LEVEL_LABEL[p.level]}）`).join("、")
      : "（无）"}`,
  ].join("\n");
}

export async function wikiSetGrant(
  userId: string, productionId: string, args: WikiSetGrantArgs,
): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法修改分享设置。";

  const doc = await getWiki(args.wikiId, productionId);
  if (!doc) return "没有找到该文档。";
  if (!await canShareWiki(resolved.actor, productionId, args.wikiId)) {
    return `权限被拒绝：你没有这篇文档的分享权限（需要 ${sharePermissionKey(args.wikiId)}）。` +
      "能编辑正文不等于能改谁看得见——请让用户在「申请访问」入口申请该权限后重试。";
  }

  // ── 先整体校验再落库：宁可一条都不改，也不要改一半留下半套分享设置 ──
  const addPeople = args.addPeople ?? [];
  const removeIds = args.removePeopleUserIds ?? [];

  const badLevel = addPeople.find((p) => !SHARE_LEVELS.includes(p.level));
  if (badLevel) return `无效的分享级别「${badLevel.level}」，只能是 view / edit / manage。`;

  const conflicted = addPeople.find((p) => removeIds.includes(p.userId));
  if (conflicted) return `同一个人（id: ${conflicted.userId}）既在 addPeople 又在 removePeopleUserIds 里，无法判断意图，未做任何修改。`;

  if (args.deptIds !== undefined) {
    const depts = await listProductionDepts(productionId);
    const byId = new Map(depts.map((d) => [d.id, d]));
    const unknown = args.deptIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      return `以下 id 不是本制作的部门：${unknown.join("、")}。请先用 production.department_list 取得正确的部门 id，未做任何修改。`;
    }
    // 人类界面的部门分享栏只列 kind='dept'（用户组是选人用的），AI 视角跟齐。
    const groups = args.deptIds.filter((id) => byId.get(id)!.kind === "group");
    if (groups.length > 0) {
      return `以下是用户组不是部门，文档分享只支持部门：${groups.map((id) => byId.get(id)!.name).join("、")}。未做任何修改。`;
    }
  }

  const changes: string[] = [];
  if (args.isPublic !== undefined) {
    await setWikiPublic(args.wikiId, productionId, args.isPublic);
    changes.push(args.isPublic ? "已设为全体成员可见" : "已取消全体成员可见");
  }
  if (args.deptIds !== undefined) {
    // 整体替换（不是增量追加）——工具描述里也写明了这点。
    await setWikiDeptShares(args.wikiId, productionId, args.deptIds);
    changes.push(args.deptIds.length > 0 ? `部门分享已设为 ${args.deptIds.length} 个部门` : "已清空部门分享");
  }
  for (const p of addPeople) {
    const r = await addWikiSharePerson(args.wikiId, productionId, { userId: p.userId, level: p.level, confirmedBy: userId });
    changes.push(r === "ok"
      ? `已把文档分享给 ${p.userId}（${LEVEL_LABEL[p.level]}）`
      : `未能分享给 ${p.userId}：对方不是本项目成员`);
  }
  for (const uid of removeIds) {
    await removeWikiSharePerson(args.wikiId, productionId, uid);
    changes.push(`已撤销 ${uid} 的单独分享`);
  }

  if (changes.length === 0) {
    return ["没有提供任何要修改的分享设置，未做变更。", "", await shareStateText(args.wikiId, productionId)].join("\n");
  }
  return [...changes.map((c) => `- ${c}`), "", await shareStateText(args.wikiId, productionId)].join("\n");
}
