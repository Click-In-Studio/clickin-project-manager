import { type NextRequest } from "next/server";
import { updatePresence } from "@/lib/server-cache";
import { getActiveVersionId, getVersion, getProductionPermissionContext } from "@/lib/db";
import { getSession } from "@/lib/session";
import { hasPermission } from "@/lib/permissions";

type PresenceBody = {
  clientId: string;
  userName: string;
  blockId: string | null;
  versionId?: string;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !hasPermission("script:view", access.permCtx))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const { clientId, userName, blockId, versionId: bodyVersionId } = (await req.json()) as PresenceBody;
  if (!clientId || !userName) return Response.json({ error: "missing fields" }, { status: 400 });
  const versionId = bodyVersionId ?? req.nextUrl.searchParams.get("v") ?? await getActiveVersionId(id) ?? '';
  if (versionId) {
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
  }
  updatePresence(id, versionId, clientId, userName, blockId);
  return Response.json({ ok: true });
}
