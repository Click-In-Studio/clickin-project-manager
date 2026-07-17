import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getActiveVersionId, getVersion, saveScriptConfig } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { broadcastEvent } from "@/lib/server-cache";
import type { ScriptConfig } from "@/lib/script-types";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script-types";

export async function PUT(req: NextRequest, ctx: RouteContext<"/api/script/[id]/config">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (isArchived) return Response.json({ error: "已归档" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权修改剧本设置" }, { status: 403 });
  }

  const versionId = req.nextUrl.searchParams.get("v") ?? await getActiveVersionId(id) ?? '';
  if (versionId) {
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
  }
  const body = (await req.json()) as Partial<ScriptConfig>;
  const config: ScriptConfig = { ...DEFAULT_SCRIPT_CONFIG, ...body };

  await saveScriptConfig(id, versionId || null, config);
  // Broadcast config change to all connected SSE clients for this version
  broadcastEvent(id, versionId, "config", config);

  return Response.json({ ok: true });
}
