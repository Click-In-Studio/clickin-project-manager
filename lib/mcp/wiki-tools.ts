// wiki.* 项目工具——production.* 族的一部分（门 = 成员资格 + 实例级可见性，
// 复用 production-tools.ts 的 resolveProductionActor/DENIED_NOT_MEMBER）。
// 语法方言声明见 ./wiki-link-syntax（教会模型别瞎发明 [[标题]] 语法）。

import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import {
  listWikiLibrary, getWiki, listBacklinks, listOutgoingLinks, searchWiki,
  extractWikiLinkTargets, createWiki, type WikiListEntry, type WikiRef,
} from "@/lib/wiki-db";
import { canViewWiki, listVisibleWikiIds } from "@/lib/wiki-perm";
import { hasEffectiveGrant, type GrantActor } from "@/lib/grant-check";
import { getPool } from "@/lib/pg";
import {
  getWikiProposalByToolCallId,
  markWikiProposalApplied, markWikiProposalBlocked,
} from "@/lib/wiki-proposal-db";

const DENIED_NOT_VISIBLE = "权限被拒绝：你看不到这篇文档。";
/** wiki 创建门的 node 权限键——AccessRequestModal 的 permission prop 用同一字符串锁定表单。 */
export const CREATE_PERMISSION_KEY = "node:wiki/*@create";

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

// ─── wiki.propose ───────────────────────────────────────────────────────────
// 门控原则（project_ai_infra 记忆）：本工具只在插件确认门批准（allow-once）
// 后才会真正被调用——这里再查一遍权限是真正的安全边界，不信任 /wiki-proposal
// 预持久化时算出的 has_permission（那只是给确认卡片/预览 modal 用的展示值）。

export async function wikiPropose(
  userId: string, productionId: string, toolCallId: string,
  args: { parentId?: string | null; title: string; body?: string; summary: string },
): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法新建文档。";

  const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
  const allowed = await hasEffectiveGrant(resolved.actor, productionId, "wiki", "*", "*", "create");

  if (!allowed) {
    if (proposal) await markWikiProposalBlocked(proposal.id);
    return "权限被拒绝：你没有在该制作新建文档的权限。已记录本次调用，需人工审批通过后才能重试。";
  }

  const doc = await createWiki({
    productionId, title: args.title, body: args.body ?? "",
    parentId: args.parentId ?? null, createdBy: userId, origin: "ai-proposed",
  });
  if (proposal) await markWikiProposalApplied(proposal.id, doc.id);
  return `已创建文档《${doc.title}》（id: ${doc.id}）。`;
}
