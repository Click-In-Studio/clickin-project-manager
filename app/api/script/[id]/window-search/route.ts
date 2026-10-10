import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getActiveVersionId, getVersion } from "@/lib/script/version-db";
import { searchScriptBlockMatches } from "@/lib/script/script-search-db";

async function resolveVersion(req: NextRequest, productionId: string): Promise<string | null> {
  const requested = req.nextUrl.searchParams.get("v");
  const versionId = requested ?? await getActiveVersionId(productionId);
  if (!versionId) return null;
  const version = await getVersion(versionId);
  return version?.productionId === productionId ? versionId : null;
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]/window-search">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !await hasEffectiveGrant(access.permCtx, id, "script", "*", "blocks", "view")) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }
  const versionId = await resolveVersion(req, id);
  if (!versionId) return Response.json({ error: "无可用版本" }, { status: 404 });
  const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query) return Response.json({ matches: [] });
  const exact = req.nextUrl.searchParams.get("exact") === "1";
  const matches = await searchScriptBlockMatches(versionId, query, exact);
  return Response.json({ matches });
}
