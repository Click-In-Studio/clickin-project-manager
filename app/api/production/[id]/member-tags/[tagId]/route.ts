import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, deleteMemberTag } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; tagId: string }> },
) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id: productionId, tagId } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "member", "*", "roles", "edit"))) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  try {
    await deleteMemberTag(tagId, productionId);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === "TAG_NOT_FOUND") return Response.json({ error: "标签不存在" }, { status: 404 });
      if (e.message === "TAG_NOT_DELETABLE") return Response.json({ error: "不能删除系统标签" }, { status: 403 });
    }
    throw e;
  }
}
