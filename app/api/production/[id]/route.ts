import { type NextRequest } from "next/server";
import { loadProduction, canUserAccessProduction, getActiveVersionId, listVersions, updateProductionName, getProductionMemberContext, ensureScriptMarkerMigration, getVersion } from "@/lib/db";
import { getSession } from "@/lib/session";
import { hasPermission } from "@/lib/roles";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]">) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;

  if (!session.isAdmin) {
    const ok = await canUserAccessProduction(session.openId, id);
    if (!ok) return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }

  try {
    const versionId = req.nextUrl.searchParams.get("v") ?? await getActiveVersionId(id);
    if (!versionId) {
      return Response.json({ error: "剧本不存在或无版本" }, { status: 404 });
    }
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }

    const migration = await ensureScriptMarkerMigration(versionId);
    if (migration.status === "running") {
      return Response.json({ status: "updating", migration }, { status: 202 });
    }

    const [result, versions] = await Promise.all([
      loadProduction(id, versionId),
      listVersions(id),
    ]);

    if (!result) {
      return Response.json({ error: "剧本不存在" }, { status: 404 });
    }

    return Response.json({ state: result.state, versionId, versions });
  } catch (err) {
    console.error("[production] load error:", err);
    return Response.json({ error: "加载失败" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]">) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权修改" }, { status: 403 });
  }

  const { name } = await req.json() as { name?: string };
  if (!name?.trim()) return Response.json({ error: "名称不能为空" }, { status: 400 });

  await updateProductionName(id, name.trim());
  return Response.json({ ok: true });
}
