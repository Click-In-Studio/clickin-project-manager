// wiki 提议的预持久化 + 方言校验（#333 T2 真门）。原是 MCP 服务器的 /wiki-proposal
// 端点（网关与插件已退役），现在只有自建运行时（#367，进程内审批门）一个调用方。
//
// 返回三态与端点/插件约定一致：ok（含 restoredBody）| rejected（422：problems +
// 说明书）。这里算出的 hasPermission 只是给确认卡片/预览 modal 的展示值——
// 真正的安全边界是各 wiki_propose_* 工具函数批准后自己重新查一遍权限。

import { getPool } from "@/lib/pg";
import { WIKI_LINK_SYNTAX_NOTE, WIKI_DIALECT_NOTE } from "./wiki-link-syntax";
import { extractDisplayTitles, restoreAndCheckBody } from "./wiki-dialect-check";

export type WikiProposalAction = "create" | "update" | "delete" | "move" | "tag";

export interface PrepareWikiProposalInput {
  productionId: string;
  toolCallId: string;
  callerUserId: string;
  action: WikiProposalAction;
  wikiId?: string;
  parentId?: string;
  newParentId?: string;
  title?: string;
  body?: string;
  tags?: string[];
  summary?: string;
}

export type PrepareWikiProposalResult =
  | { ok: true; id: string; hasPermission: boolean; reason: "not_member" | "archived" | "no_grant" | null; restoredBody?: string }
  | { ok: false; problems: string[]; guide: string };

export const WIKI_DIALECT_GUIDE = `${WIKI_LINK_SYNTAX_NOTE}\n\n${WIKI_DIALECT_NOTE}`;

export async function prepareWikiProposal(input: PrepareWikiProposalInput): Promise<PrepareWikiProposalResult> {
  const { productionId, toolCallId, callerUserId, action } = input;
  const wikiId = input.wikiId ?? "";
  const docBody = input.body ?? "";
  const title = input.title ?? null;
  const tags = input.tags ?? null;
  const summary = input.summary ?? "";
  const parentWikiId = action === "create" ? (input.parentId ?? null)
    : action === "move" ? (input.newParentId ?? null)
    : null;

  const { resolveProductionActor } = await import("./production-tools");
  const { CREATE_PERMISSION_KEY, editPermissionKey, deletePermissionKey } = await import("./wiki-tools");
  const { hasEffectiveGrant } = await import("../grant-check");
  const { canEditWiki, canDeleteWiki } = await import("../wiki-perm");
  const { insertWikiProposal } = await import("../wiki-proposal-db");

  // ── 方言校验 + [[标题]] 反解（真门）：失败不落 wiki_proposal 行 ─────────────
  let effectiveBody = docBody;
  let bodyRestored = false;
  if ((action === "create" || action === "update") && docBody) {
    const titles = extractDisplayTitles(docBody);
    const titleIds = new Map<string, string[]>();
    if (titles.length > 0) {
      const rows = await getPool().query<{ id: string; title: string }>(
        `SELECT id::text AS id, title FROM wiki WHERE production_id = $1 AND title = ANY($2::text[])`,
        [productionId, titles],
      );
      for (const r of rows.rows) {
        const list = titleIds.get(r.title) ?? [];
        list.push(r.id);
        titleIds.set(r.title, list);
      }
    }
    let oldBody: string | null = null;
    if (action === "update") {
      const { getWiki } = await import("../wiki-db");
      oldBody = (await getWiki(wikiId, productionId))?.body ?? null;
    }
    const checked = restoreAndCheckBody(docBody, titleIds, oldBody);
    if (!checked.ok) return { ok: false, problems: checked.problems, guide: WIKI_DIALECT_GUIDE };
    effectiveBody = checked.body;
    bodyRestored = checked.restoredCount > 0;
  }

  let hasPermission = false;
  let reason: "not_member" | "archived" | "no_grant" | null = null;
  const resolved = await resolveProductionActor(callerUserId, productionId);
  if (!resolved) {
    reason = "not_member";
  } else if (resolved.isArchived) {
    reason = "archived";
  } else if (action === "create") {
    hasPermission = await hasEffectiveGrant(resolved.actor, productionId, "wiki", "*", "*", "create");
  } else if (action === "delete") {
    hasPermission = await canDeleteWiki(resolved.actor, productionId, wikiId);
  } else {
    hasPermission = await canEditWiki(resolved.actor, productionId, wikiId); // update / move / tag 都是"编辑"这篇
  }
  if (resolved && !resolved.isArchived && !hasPermission) reason = "no_grant";

  const permissionKey = action === "create" ? CREATE_PERMISSION_KEY
    : action === "delete" ? deletePermissionKey(wikiId)
    : editPermissionKey(wikiId);

  const proposal = await insertWikiProposal({
    productionId, toolCallId, proposedBy: callerUserId, action,
    targetWikiId: action === "create" ? null : wikiId, parentWikiId,
    title, body: effectiveBody, tags, summary, hasPermission, permissionKey,
  });
  return { ok: true, id: proposal.id, hasPermission, reason, ...(bodyRestored ? { restoredBody: effectiveBody } : {}) };
}
