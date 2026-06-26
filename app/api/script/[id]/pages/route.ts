import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getActiveVersionId, loadProduction, ensureScriptMarkerMigration, getVersion } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { computePageMap } from "@/lib/script-page";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]/pages">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
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
    const migration = await ensureScriptMarkerMigration(versionId);
    if (migration.status === "running") {
      return Response.json({ status: "updating", migration }, { status: 202 });
    }
  }
  const result = await loadProduction(id, versionId);
  const blocks = result?.state.blocks ?? [];
  return Response.json({ pageMap: computePageMap(blocks) });
}
