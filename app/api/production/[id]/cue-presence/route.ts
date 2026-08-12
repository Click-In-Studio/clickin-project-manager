import { type NextRequest } from "next/server";
import { updateCuePresence } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasAnyEffectiveGrant, toActor } from "@/lib/grant-check";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  // 批A：全项目级通道——任一 cue 表可见即可接入（admin/owner 旁路）
  const canSee = await hasAnyEffectiveGrant(
    toActor(session, access.permCtx),
    id, "cue_list", ["meta", "cues"], "view",
  );
  if (!canSee) return Response.json({ error: "无权访问" }, { status: 403 });

  const { clientId, userName, listId, cueId } = await req.json() as {
    clientId: string; userName: string; listId: string | null; cueId: string | null;
  };
  if (!clientId || !userName) return Response.json({ error: "missing fields" }, { status: 400 });
  updateCuePresence(id, clientId, userName, listId ?? null, cueId ?? null);
  return Response.json({ ok: true });
}
