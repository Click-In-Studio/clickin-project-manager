import { type NextRequest } from "next/server";
import { loadProduction, canUserAccessProduction, getActiveVersionId, listVersions } from "@/lib/db";
import { loadFromDB } from "@/lib/server-cache";
import { getSession } from "@/lib/session";

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

    const [result, versions] = await Promise.all([
      loadProduction(id, versionId),
      listVersions(id),
    ]);

    if (!result) {
      return Response.json({ error: "剧本不存在" }, { status: 404 });
    }

    loadFromDB(id, versionId, result.state, result.sortKeys, result.snapshotIds);
    return Response.json({ state: result.state, versionId, versions });
  } catch (err) {
    console.error("[production] load error:", err);
    return Response.json({ error: "加载失败" }, { status: 500 });
  }
}
