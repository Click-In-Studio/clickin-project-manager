// #510 资产写面两工具（production.asset_propose_rename / asset_propose_move）。
//
// 门与 REST 逐字同源，不另起口径：
//   改名 = PATCH /assets/[assetId] 的 asset/<id>/meta@edit（上传者行集含之）；
//   移动 = PATCH /node/[nodeId] 的本体门（同上 meta@edit）+ 位置面三道门
//          （目标父可枚举 ∧ 目标父容器可写 ∧ 换父时源父容器可写）。
// 两个工具都走确认卡（approvalGate）；无权限直接拒绝（同 wiki_set_grant 口径），
// 不进 wiki_proposal 审批流——那张表的 action 枚举是 wiki 域的 CHECK 约束。
// 预览（卡片权限三态）与执行共用同一份 plan：只看不做 vs 看完就做。

import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { getAsset, updateAsset, type Asset } from "@/lib/asset/db";
import { getNodeByAssetId, moveNode, resolveContainerNode, type NodeRecord } from "@/lib/node/db";
import { canPlaceNodeUnder, canWriteNodeContainer } from "@/lib/node/perm";
import { hasEffectiveGrant, type GrantActor } from "@/lib/perm/grant-check";

export const ASSET_PROPOSE_TOOLS: ReadonlySet<string> = new Set([
  "production-asset_propose_rename",
  "production-asset_propose_move",
]);

const DENIED_META_EDIT = "权限被拒绝：你没有修改该资产信息的权限（asset meta@edit）。";
const DENIED_CONTAINER = "权限被拒绝：你没有改动这些父节点子目录的权限。";
const NOT_FOUND = "没有找到该资产（资产 id 来自树里的 [文件] 行或 production.asset_list）。";

const label = (a: Asset) => neutralizeInjectionTags(a.name && a.name !== a.fileName ? `${a.name}（${a.fileName}）` : a.fileName);

type Prelude = { actor: GrantActor; asset: Asset };

/** 成员 + 未归档 + 资产在本制作 + 本体门（meta@edit）。三种失败都回给模型的话。 */
async function prelude(userId: string, productionId: string, assetId: string): Promise<Prelude | string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (resolved.isArchived) return "该制作已归档，无法修改资产。";
  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== productionId) return NOT_FOUND;
  if (!await hasEffectiveGrant(resolved.actor, productionId, "asset", assetId, "meta", "edit")) return DENIED_META_EDIT;
  return { actor: resolved.actor, asset };
}

export type AssetWritePreview = { hasPermission: boolean; notes: string[]; error?: string };

/** 确认卡片用：与执行同一份门，只看不做。参数/业务错误走 error（不弹卡），无权限走 hasPermission=false。 */
export async function previewAssetProposal(
  userId: string, productionId: string, bareTool: string, args: Record<string, unknown>,
): Promise<AssetWritePreview> {
  const assetId = String(args.assetId ?? "");
  const pre = await prelude(userId, productionId, assetId);
  if (typeof pre === "string") {
    return pre.startsWith("权限被拒绝") ? { hasPermission: false, notes: [pre] } : { hasPermission: false, notes: [], error: pre };
  }
  if (bareTool === "production-asset_propose_rename") {
    if (!String(args.name ?? "").trim()) return { hasPermission: false, notes: [], error: "新名称不能为空。" };
    return { hasPermission: true, notes: [`📄 ${label(pre.asset)}`] };
  }
  const plan = await planMove(pre, productionId, args);
  if (typeof plan === "string") return { hasPermission: false, notes: [], error: plan };
  return plan.allowed
    ? { hasPermission: true, notes: [`📄 ${label(pre.asset)}`, plan.where] }
    : { hasPermission: false, notes: [DENIED_CONTAINER, plan.where] };
}

// ─── rename ─────────────────────────────────────────────────────────────────

/** 改的是显示名（asset.name），与资产页的重命名同一字段；原始文件名不动（扩展名/解析判定都靠它）。 */
export async function assetProposeRename(
  userId: string, productionId: string,
  args: { assetId: string; name: string; summary: string },
): Promise<string> {
  const pre = await prelude(userId, productionId, args.assetId);
  if (typeof pre === "string") return pre;
  const name = args.name.trim();
  if (!name) return "新名称不能为空。";
  const before = label(pre.asset);
  const updated = await updateAsset(args.assetId, { name });
  if (!updated) return NOT_FOUND;
  return `已把资产 ${before} 改名为《${neutralizeInjectionTags(name)}》（资产 id: ${updated.id}）。`;
}

// ─── move ───────────────────────────────────────────────────────────────────

type MovePlan = { shell: NodeRecord; newParentNodeId: string | null; allowed: boolean; where: string };

/** 解析壳节点与目标父，跑位置面三道门。业务错误（资产没上树/目标不存在）回字符串。 */
async function planMove(pre: Prelude, productionId: string, args: Record<string, unknown>): Promise<MovePlan | string> {
  const shell = await getNodeByAssetId(pre.asset.id);
  if (!shell || shell.productionId !== productionId) return "该资产没有挂在目录树上，无法移动。";
  const ref = typeof args.newParentId === "string" ? args.newParentId.trim() : "";
  let newParentNodeId: string | null = null;
  let where = "📂 移到目录树根";
  if (ref) {
    const parent = await resolveContainerNode(productionId, ref);
    if (!parent) return "目标父不存在（newParentId 应是树里 [文档] 行的 id 或 [目录] 行的节点 id；文件不能作父）。";
    newParentNodeId = parent.id;
    where = `📂 移到「${neutralizeInjectionTags(parent.title ?? "（无标题）")}」下`;
  }
  const allowed = await canPlaceNodeUnder(pre.actor, productionId, newParentNodeId)
    && await canWriteNodeContainer(pre.actor, productionId, newParentNodeId)
    && (newParentNodeId === shell.parentId || await canWriteNodeContainer(pre.actor, productionId, shell.parentId));
  return { shell, newParentNodeId, allowed, where };
}

export async function assetProposeMove(
  userId: string, productionId: string,
  args: { assetId: string; newParentId?: string | null; summary: string },
): Promise<string> {
  const pre = await prelude(userId, productionId, args.assetId);
  if (typeof pre === "string") return pre;
  const plan = await planMove(pre, productionId, args);
  if (typeof plan === "string") return plan;
  if (!plan.allowed) return DENIED_CONTAINER;
  try {
    await moveNode(plan.shell.id, productionId, { parentId: plan.newParentNodeId });
  } catch (err) {
    return err instanceof Error ? err.message : "移动失败：目标父不合法。";
  }
  return plan.newParentNodeId
    ? `已把资产 ${label(pre.asset)} 移动到新的父节点下。`
    : `已把资产 ${label(pre.asset)} 移动到目录树根。`;
}
