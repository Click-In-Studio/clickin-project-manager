import { type NextRequest } from "next/server";
import { getState, applyPatch } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionCharacters } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map() };
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const characters = await listProductionCharacters(id);
  return Response.json(characters);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const { name } = await req.json();
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return Response.json({ error: "名称不能为空" }, { status: 400 });

  const state = getState(id);
  const newChar = { id: `c${Date.now().toString(36)}`, name: trimmed };
  // check duplicate
  if (state.characters.some((c) => c.name === trimmed)) {
    return Response.json({ error: "角色名已存在" }, { status: 409 });
  }

  await applyPatch(id, { clientSeq: 0, blockOps: [], charOps: [{ op: "upsert", char: newChar }], sceneOps: [] });
  return Response.json({ ok: true, char: newChar }, { status: 201 });
}
