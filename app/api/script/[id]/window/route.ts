import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getActiveVersionId, getVersion } from "@/lib/script/version-db";
import { loadScriptWindow, loadScriptWindowBootstrap } from "@/lib/script/script-window-db";

async function resolveVersion(req: NextRequest, productionId: string): Promise<string | null> {
  const requested = req.nextUrl.searchParams.get("v");
  const versionId = requested ?? await getActiveVersionId(productionId);
  if (!versionId) return null;
  const version = await getVersion(versionId);
  return version?.productionId === productionId ? versionId : null;
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]/window">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !await hasEffectiveGrant(access.permCtx, id, "script", "*", "blocks", "view")) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }
  const versionId = await resolveVersion(req, id);
  if (!versionId) return Response.json({ error: "无可用版本" }, { status: 404 });

  const start = Number(req.nextUrl.searchParams.get("start") ?? 0);
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 240);
  if (req.nextUrl.searchParams.get("bootstrap") === "1") {
    const bootstrap = await loadScriptWindowBootstrap(id, versionId, start, limit);
    return bootstrap
      ? Response.json(bootstrap)
      : Response.json({ error: "版本不存在" }, { status: 404 });
  }
  const result = await loadScriptWindow(id, versionId, start, limit);
  if (!result) return Response.json({ error: "版本不存在" }, { status: 404 });

  const expectedRevision = req.nextUrl.searchParams.get("orderRevision");
  if (expectedRevision !== null && expectedRevision !== result.orderRevision) {
    return Response.json(
      { error: "剧本结构已变化", orderRevision: result.orderRevision },
      { status: 409 },
    );
  }
  return Response.json(result);
}
