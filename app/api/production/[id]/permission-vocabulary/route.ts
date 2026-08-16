import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasAdminPanelEligibility } from "@/lib/permissions";
import { getPermissionVocabulary } from "@/lib/perm-center-db";

// GET — 权限键词汇（type→verbs 闭集 + type→在用 sub 面）。
// 词汇是 schema 性数据（不含任何人的授权），门=管理面资格。
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(session.isAdmin || permCtx.isAdmin || permCtx.isOwner || hasAdminPanelEligibility(permCtx.memberPermissions))) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }
  return Response.json({ vocabulary: await getPermissionVocabulary(id) });
}
