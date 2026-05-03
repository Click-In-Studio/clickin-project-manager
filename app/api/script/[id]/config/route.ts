import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { saveScriptConfig } from "@/lib/db";
import { applyConfig } from "@/lib/server-cache";
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
  const body = (await req.json()) as Partial<ScriptConfig>;
  const config: ScriptConfig = { ...DEFAULT_SCRIPT_CONFIG, ...body };

  await saveScriptConfig(id, config);
  applyConfig(id, versionId, config);

  return Response.json({ ok: true });
}
