import { type NextRequest } from "next/server";
import { updateCuePresence } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !hasPermission("cue_list:view", access.permCtx))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const { clientId, userName, listId, cueId } = await req.json() as {
    clientId: string; userName: string; listId: string | null; cueId: string | null;
  };
  if (!clientId || !userName) return Response.json({ error: "missing fields" }, { status: 400 });
  updateCuePresence(id, clientId, userName, listId ?? null, cueId ?? null);
  return Response.json({ ok: true });
}
