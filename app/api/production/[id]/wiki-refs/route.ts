import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasGrant } from "@/lib/grant-check";
import { canAccessNode } from "@/lib/grant-template";
import { getPool } from "@/lib/pg";
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
      // 剧本域三 kind 同门（mention-resolve 同款：blocks@view）
      return permCtx.isAdmin || permCtx.isOwner
        || await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "view");
    case "cue": {
      const r = await getPool().query<{ cue_list_id: string }>(
        `SELECT c.cue_list_id FROM cue c
         JOIN cue_list cl ON cl.id = c.cue_list_id
         WHERE c.id = $1 AND cl.production_id = $2`,
        [entityId, productionId],
      );
      if (!r.rows[0]) return false;
      const access = await canAccessNode(
        permCtx, productionId, "cue_list", r.rows[0].cue_list_id, "cues", "view");
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
