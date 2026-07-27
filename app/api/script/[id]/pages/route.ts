import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getActiveVersionId, loadProduction, getVersion } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { computePageMap } from "@/lib/script-page";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]/pages">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!hasPermission("script:view", permCtx)) {
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
  if (versionId) {
  }
  const result = await loadProduction(id, versionId);
  const blocks = result?.state.blocks ?? [];
  return Response.json({ pageMap: computePageMap(blocks) });
}
