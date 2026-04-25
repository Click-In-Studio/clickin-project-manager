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

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes/[sceneId]">) {
  const { id, sceneId } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const state = getState(id);
  const scene = state.scenes.find((s) => s.id === sceneId);
  if (!scene) return Response.json({ error: "未找到章节" }, { status: 404 });

  const body = await req.json();
  const updated = {
    ...scene,
    number: typeof body.number === "string" ? body.number.trim() : scene.number,
    name:   typeof body.name   === "string" ? body.name.trim()   : scene.name,
  };

  await applyPatch(id, { clientSeq: 0, blockOps: [], charOps: [], sceneOps: [{ op: "upsert", scene: updated }] });
  return Response.json({ ok: true, scene: updated });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes/[sceneId]">) {
  const { id, sceneId } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(_req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  await applyPatch(id, { clientSeq: 0, blockOps: [], charOps: [], sceneOps: [{ op: "delete", id: sceneId }] });
  return Response.json({ ok: true });
}
