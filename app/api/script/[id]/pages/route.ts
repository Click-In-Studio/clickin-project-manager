import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getActiveVersionId, getVersion, getEstimatedPageMap } from "@/lib/db";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]/pages">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, id, "script", "*", "blocks", "view"))) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const requestedVersionId = req.nextUrl.searchParams.get("v");
  const versionId = requestedVersionId ?? await getActiveVersionId(id) ?? '';
  if (versionId) {
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
  }
  if (!versionId) return Response.json({ pageMap: {} });
  // 页码按演出实际版式取（#336）：此前这里缺省 a4/center
  return Response.json({ pageMap: await getEstimatedPageMap(id, versionId) });
}
