import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getAsset } from "@/lib/asset/db";
import { canManageShareLinks } from "@/lib/asset/perm";
import { revokeAssetShareLink } from "@/lib/asset/share-link-db";

type Ctx = { params: Promise<{ id: string; assetId: string; linkId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, assetId, linkId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) {
    return Response.json({ error: "资产不存在" }, { status: 404 });
  }
  const cap = await canManageShareLinks(access.permCtx, id, asset);
  if (!cap.allowed) return Response.json({ error: "权限不足" }, { status: 403 });

  const revoked = await revokeAssetShareLink(id, assetId, linkId);
  if (!revoked) return Response.json({ error: "链接不存在或已撤销" }, { status: 404 });
  return Response.json({ ok: true });
}
