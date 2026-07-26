import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, createTagOption } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, access: null };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  return { session, access };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; groupId: string }> }) {
  const { id, groupId } = await ctx.params;
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("scene:rename", permCtx)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return Response.json({ error: "标签名不能为空" }, { status: 400 });
  const color = typeof body.color === "string" ? body.color : "#a1a1aa";
  const sortOrder = typeof body.sortOrder === "number" ? body.sortOrder : 0;

  const option = await createTagOption(groupId, label, color, sortOrder);
  return Response.json({ ok: true, option }, { status: 201 });
}
