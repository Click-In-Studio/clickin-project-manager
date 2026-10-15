import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { getWiki, updateWiki } from "@/lib/wiki/content";
import { canViewWiki, canEditWiki } from "@/lib/wiki/perm";
import { broadcastWikiUpdate } from "@/lib/wiki/collab";
import { getWikiProposalByToolCallId, markWikiProposalApplied, markWikiProposalBlocked } from "@/lib/wiki/proposal-db";
import { getWikiPatchApproval } from "@/lib/agent/wiki-patch-db";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import { prepareWikiProposal } from "./wiki-proposal-prepare";
import { applyWikiPatch, type WikiPatchEdit } from "./wiki-text";

export type WikiPatchArgs = { wikiId: string; edits: WikiPatchEdit[]; summary: string };
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

export async function prepareWikiPatch(userId: string, productionId: string, toolCallId: string, args: WikiPatchArgs) {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return { error: DENIED_NOT_MEMBER };
  if (resolved.isArchived) return { error: "该制作已归档，无法修改文档。" };
  if (!await canViewWiki(resolved.actor, productionId, args.wikiId)) return { error: "权限被拒绝：你看不到这篇文档。" };
  const hasPermission = await canEditWiki(resolved.actor, productionId, args.wikiId);
  const previous = await getWikiPatchApproval(userId, productionId, toolCallId);
  if (previous) {
    if (previous.status === "denied") return { error: neutralizeInjectionTags(`Denied by user${previous.reason ? `\n用户拒绝理由：${previous.reason}` : ""}`) };
    if (previous.status !== "pending" && previous.status !== "allowed") return { error: "该提议已结束，请重新读取后发起新提议。" };
    const existing = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
    if (!existing || existing.status !== "pending") return { error: "该提议已经处理，请重新读取后发起新提议。" };
    return { hasPermission, preview: previous.preview, notes: [`共修改 ${previous.preview.patchCounts.reduce((a, b) => a + b, 0)} 处。`] };
  }
  const doc = await getWiki(args.wikiId, productionId);
  if (!doc) return { error: "没有找到该文档。" };
  try {
    const patched = applyWikiPatch(doc.body, args.edits);
    const prepared = await prepareWikiProposal({
      productionId, callerUserId: userId, toolCallId, action: "update",
      wikiId: args.wikiId, body: patched.body, summary: args.summary,
    });
    if (!prepared.ok) return { error: neutralizeInjectionTags(`方言校验拒绝：${prepared.problems.join("；")}\n${prepared.guide}`) };
    const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
    if (!proposal || proposal.status !== "pending") return { error: "该提议已结束，不能再次执行。" };
    const preview = {
      baseHash: hash(doc.body), patchCounts: patched.counts, hasPermission, proposalId: prepared.id,
      patchDiff: createTwoFilesPatch("修改前", "修改后", doc.body, proposal.body, "", "", { context: 3 }),
    };
    return { hasPermission, preview, notes: [`${args.edits.length} 项修改，共匹配 ${patched.counts.reduce((a, b) => a + b, 0)} 处。`] };
  } catch (error) {
    return { error: neutralizeInjectionTags(error instanceof Error ? error.message : String(error)) };
  }
}

/** 执行只消费已确认的服务端结果，不重新匹配或重新解释模型参数。 */
export async function wikiProposePatch(userId: string, productionId: string, toolCallId: string, args: WikiPatchArgs): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法修改文档。";
  const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
  if (!await canEditWiki(resolved.actor, productionId, args.wikiId)
      || !await canViewWiki(resolved.actor, productionId, args.wikiId)) {
    if (proposal) await markWikiProposalBlocked(proposal.id, "blocked_no_permission");
    return "权限被拒绝：你没有查看或编辑这篇文档的权限。";
  }
  const approval = await getWikiPatchApproval(userId, productionId, toolCallId);
  if (!proposal || proposal.action !== "update" || proposal.targetWikiId !== args.wikiId
      || !approval || approval.status !== "allowed" || approval.preview.proposalId !== proposal.id) {
    return "没有找到已确认的局部修改提议，未修改文档。";
  }
  if (proposal.status !== "pending") return "该提议已经处理，未重复修改文档。";
  const doc = await getWiki(args.wikiId, productionId);
  if (!doc) return "没有找到该文档。";
  if (hash(doc.body) !== approval.preview.baseHash) {
    await markWikiProposalBlocked(proposal.id, "blocked_business_rule");
    return "文档在提议后已发生变化；整批未执行。请重新 search/read 后发起新提议。";
  }
  try {
    const updated = await updateWiki(args.wikiId, productionId, {
      body: proposal.body, expectedBody: doc.body, origin: "ai-proposed",
    }, userId);
    if (!updated) return "没有找到该文档。";
    await markWikiProposalApplied(proposal.id, updated.id);
    broadcastWikiUpdate(updated.id, { byClientId: null, title: updated.title, body: updated.body, updatedAt: updated.updatedAt });
    return neutralizeInjectionTags(`已局部修改文档《${updated.title}》（id: ${updated.id}），共 ${approval.preview.patchCounts.reduce((a, b) => a + b, 0)} 处。`);
  } catch (error) {
    if (error instanceof Error && error.message === "WIKI_BODY_CHANGED") {
      await markWikiProposalBlocked(proposal.id, "blocked_business_rule");
      return "文档在写入前已发生变化；整批未执行。请重新 search/read 后发起新提议。";
    }
    throw error;
  }
}
