// wiki.* 项目工具——production.* 族的一部分（门 = 成员资格 + 实例级可见性，
// 复用 production-tools.ts 的 resolveProductionActor/DENIED_NOT_MEMBER）。
// 语法方言声明见 ./wiki-link-syntax（教会模型别瞎发明 [[标题]] 语法）。

import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import {
  listWikiLibrary, getWiki, listBacklinks, listOutgoingLinks, searchWiki,
  extractWikiLinkTargets, createWiki, updateWiki, deleteWiki,
  type WikiListEntry, type WikiRef,
} from "@/lib/wiki-db";
import { canViewWiki, canEditWiki, canDeleteWiki, listVisibleWikiIds } from "@/lib/wiki-perm";
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

export async function wikiTree(userId: string, productionId: string): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  const all = await listWikiLibrary(productionId);
  const visible = await filterVisible(resolved.actor, productionId, all);
  return buildTreeText(visible);
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
  return [
    "谁链接到它（backlinks）：",
    formatRefs(incoming),
    "",
    "它链接到谁（outgoing）：",
    formatRefs(outgoing),
  ].join("\n");
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
const WIKI_MD_LINK_RE = /\[[^[\]]*\]\(\/__cm__wiki:([0-9a-fA-F-]{36})(?:[?&][^)]*)?\)/g;

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
  return lines.join("\n");
}

// ─── wiki.search ────────────────────────────────────────────────────────────

export async function wikiSearch(userId: string, productionId: string, query: string): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;

  const results = await searchWiki(productionId, query);
  const visible = await filterVisible(resolved.actor, productionId, results);
  return visible.length === 0 ? "（没有匹配的文档）" : formatRefs(visible);
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
