import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getCueListIdForCue } from "@/lib/db";
import { hasGrant } from "@/lib/grant-check";
import { canAccessNode } from "@/lib/grant-template";
import { listWikiRefsForEntity } from "@/lib/wiki-db";
import { canViewAsset } from "@/lib/asset-perm";
import { getAsset } from "@/lib/asset-db";
import type { PermissionContext } from "@/lib/permissions";

// 对象侧"相关 wiki"面板：引用了该实体的 wiki 列表。
// 门 = 宿主对象的可见性（面板长在宿主页上，per-type 沿用各域现有读取门）；
// wiki 侧刻意标题级列出、不过滤 wiki 可见性——名字不敏感、内容敏感（§4.1），
// 点击处由 wiki 页过门+申请。与 backlinks 端点（wiki 页反向面板）同构。
// wiki→wiki 不走此端点（已有 /wiki/[wikiId]/backlinks）。

const ENTITY_TYPES = new Set(["scene", "rehearsal", "block", "cue", "asset"]);

async function hostViewPermitted(
  permCtx: PermissionContext, productionId: string, entityType: string, entityId: string,
): Promise<boolean> {
  switch (entityType) {
    case "scene":
    case "rehearsal":
    case "block":
      // 剧本域三 kind 同门（mention-resolve 同款：blocks@view）。不校验 entityId
      // 归属本 production（cue/asset 分支的归属校验是过门必需的副产品——门长在
      // 实例上，先找宿主才知道门在哪；剧本域门是 production 级通配，无宿主可找）：
      // 传外剧组 id 也只能查到 *本* production 的边（listWikiRefsForEntity 按
      // production_id 过滤），返回的是本剧组 wiki 的标题级信息，观看者已过本域门
      return permCtx.isAdmin || permCtx.isOwner
        || await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "view");
    case "cue": {
      const cueListId = await getCueListIdForCue(entityId, productionId);
      if (!cueListId) return false;
      const access = await canAccessNode(
        permCtx, productionId, "cue_list", cueListId, "cues", "view");
      return access.allowed;
    }
    case "asset": {
      const asset = await getAsset(entityId);
      if (!asset || asset.productionId !== productionId) return false;
      return canViewAsset(permCtx, productionId, asset, "meta");
    }
    default:
      return false;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const entityType = req.nextUrl.searchParams.get("type") ?? "";
  const entityId = req.nextUrl.searchParams.get("id") ?? "";
  if (!ENTITY_TYPES.has(entityType) || !entityId) {
    return Response.json({ error: "非法的实体类型或 id" }, { status: 400 });
  }

  if (!await hostViewPermitted(access.permCtx, productionId, entityType, entityId)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }

  const refs = await listWikiRefsForEntity(productionId, entityType, entityId);
  return Response.json({ refs });
}
