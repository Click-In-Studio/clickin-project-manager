import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, archiveProduction, unarchiveProduction } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string }> };

async function requireManage(req: NextRequest, productionId: string, verb: "create" | "delete") {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx } = access;
  if (!(permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, productionId, "production", "*", "archival", verb)))
    return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { deny: null };
}

// Archive the production (idempotent)
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireManage(req, id, "create");
  if (deny) return deny;
  await archiveProduction(id);
  return Response.json({ ok: true });
}

// Unarchive the production (idempotent)
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireManage(req, id, "delete");
  if (deny) return deny;
  await unarchiveProduction(id);
  return Response.json({ ok: true });
}
