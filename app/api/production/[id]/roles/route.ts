import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { listProductionRolesWithPermissions, createProductionRole } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

// 读门（GET）沿用人事 override 编辑资格（旧 permissions 页共用）；
// 写门走 role 域细分节点。
async function requireGate(req: NextRequest, productionId: string, sub: string, verb: "view" | "create" | "edit" | "delete") {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const ok = session.isAdmin || access.permCtx.isAdmin || access.permCtx.isOwner ||
    (verb === "view"
      ? await hasGrant(access.permCtx.userId, productionId, "member", "*", "overrides", "edit")
      : await hasGrant(access.permCtx.userId, productionId, "role", "*", sub, verb));
  if (!ok) return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  if (verb !== "view" && access.isArchived) return { deny: Response.json({ error: "已归档" }, { status: 403 }) };
  return { deny: null };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "*", "view");
  if (deny) return deny;
  const roles = await listProductionRolesWithPermissions(id);
  return Response.json({ roles });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "*", "create");
  if (deny) return deny;
  const body = (await req.json()) as { name?: string };
  const name = body.name?.trim();
  if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });
  const role = await createProductionRole(id, name);
  return Response.json({ role }, { status: 201 });
}
