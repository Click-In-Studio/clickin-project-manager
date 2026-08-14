import { type NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";

import { setRolePermissions } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; roleId: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }), access: null };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }), access: null };
  if (!session.isAdmin && !(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, productionId, "member", "*", "overrides", "edit")))
    return { deny: Response.json({ error: "权限不足" }, { status: 403 }), access };
  if (access.isArchived) return { deny: Response.json({ error: "已归档" }, { status: 403 }), access };
  return { deny: null, access };
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id, roleId } = await ctx.params;
  const { deny, access } = await requireManage(req, id);
  if (deny) return deny;
  // 批G：修改制作人权限集合 = ROOT OPERATION（owner∨admin 硬判），与普通治理分开
  const target = await getPool().query<{ name: string }>(
    "SELECT name FROM production_role WHERE id = $1 AND production_id = $2", [roleId, id]);
  if (target.rows[0]?.name === "制作人"
      && !(access!.permCtx.isOwner || access!.permCtx.isAdmin))
    return Response.json({ error: "制作人权限集合仅限所有者修改" }, { status: 403 });
  const body = (await req.json()) as { permissions?: unknown };
  if (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== "string"))
    return Response.json({ error: "permissions 必须是字符串数组" }, { status: 400 });
  // 终局：治理域节点串（production/producer）不可经普通角色编辑写入——
  // SENSITIVE 入口资格行的发放属 owner 域（与制作人权限集合同 ROOT 语义）
  const filtered = (body.permissions as string[]).filter(
    (p) => !p.startsWith("node:production/") && !p.startsWith("node:producer/"));
  await setRolePermissions(roleId, filtered);
  return Response.json({ ok: true, permissions: filtered });
}
