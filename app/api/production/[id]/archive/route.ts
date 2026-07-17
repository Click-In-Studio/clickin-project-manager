import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, archiveProduction, unarchiveProduction } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

type Ctx = { params: Promise<{ id: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides))
    return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { deny: null };
}

// Archive the production (idempotent)
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireManage(req, id);
  if (deny) return deny;
  await archiveProduction(id);
  return Response.json({ ok: true });
}

// Unarchive the production (idempotent)
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireManage(req, id);
  if (deny) return deny;
  await unarchiveProduction(id);
  return Response.json({ ok: true });
}
