import { type NextRequest } from "next/server";
import { getState, applyPatch } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map() };
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides };
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters/[charId]">) {
  const { id, charId } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const state = getState(id);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return Response.json({ error: "未找到角色" }, { status: 404 });

  const { name } = await req.json();
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return Response.json({ error: "名称不能为空" }, { status: 400 });

  const updated = { ...char, name: trimmed };
  await applyPatch(id, { clientSeq: 0, blockOps: [], charOps: [{ op: "upsert", char: updated }], sceneOps: [] });
  return Response.json({ ok: true, char: updated });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters/[charId]">) {
  const { id, charId } = await ctx.params;
  const req = _req;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  await applyPatch(id, { clientSeq: 0, blockOps: [], charOps: [{ op: "delete", id: charId }], sceneOps: [] });
  return Response.json({ ok: true });
}
