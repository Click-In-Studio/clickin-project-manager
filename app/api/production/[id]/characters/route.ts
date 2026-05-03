import { type NextRequest } from "next/server";
import { getState, applyPatch } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionCharacters, setCharacterMembers, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
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
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  const trimmed = typeof body.name === "string" ? body.name.trim() : "";
  if (!trimmed) return Response.json({ error: "名称不能为空" }, { status: 400 });
  const isAggregate = body.isAggregate === true;
  const memberIds: string[] = isAggregate && Array.isArray(body.memberIds)
    ? body.memberIds.filter((m: unknown) => typeof m === "string")
    : [];

  const versionId = await getActiveVersionId(id) ?? '';
  const state = getState(id, versionId);
  const newChar = { id: `c${Date.now().toString(36)}`, name: trimmed, isAggregate };
  // check duplicate
  if (state.characters.some((c) => c.name === trimmed)) {
    return Response.json({ error: "角色名已存在" }, { status: 409 });
  }

  await applyPatch(id, versionId, { clientSeq: 0, blockOps: [], charOps: [{ op: "upsert", char: newChar }], sceneOps: [] });
  if (isAggregate && memberIds.length > 0) {
    await setCharacterMembers(newChar.id, memberIds);
  }
  const charDetail = { ...newChar, gender: "", biography: "", roleType: "", memberIds };
  return Response.json({ ok: true, char: charDetail }, { status: 201 });
}
