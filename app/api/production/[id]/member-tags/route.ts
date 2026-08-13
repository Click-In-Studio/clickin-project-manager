import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listMemberTags, createMemberTag } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id: productionId } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const tags = await listMemberTags(productionId);
  return Response.json({ tags });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id: productionId } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "member", "*", "roles", "edit"))) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const { name } = (await req.json()) as { name?: string };
  if (!name?.trim()) return Response.json({ error: "缺少 name" }, { status: 400 });

  try {
    const tag = await createMemberTag(productionId, name.trim());
    return Response.json({ tag }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message === "SYSTEM_TAG_NAME_CONFLICT") {
      return Response.json({ error: "不能与系统标签同名" }, { status: 409 });
    }
    throw e;
  }
}
