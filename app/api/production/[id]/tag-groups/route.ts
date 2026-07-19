import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listTagGroups, createTagGroup } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const groups = await listTagGroups(id);
  return Response.json({ groups });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });
  const type = body.type === "exclusive" || body.type === "range" ? body.type : null;
  if (!type) return Response.json({ error: "类型无效" }, { status: 400 });

  const group = await createTagGroup(id, {
    name,
    type,
    rangeMin:     typeof body.rangeMin     === "number" ? body.rangeMin     : undefined,
    rangeMax:     typeof body.rangeMax     === "number" ? body.rangeMax     : undefined,
    rangeStep:    typeof body.rangeStep    === "number" ? body.rangeStep    : undefined,
    rangeDefault: typeof body.rangeDefault === "number" ? body.rangeDefault : undefined,
  });
  return Response.json({ ok: true, group }, { status: 201 });
}
