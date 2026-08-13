import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { presignedPut } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "项目不存在" }, { status: 404 });
  if (!(access.permCtx.isOwner || (access.permCtx.isAdmin && access.permCtx.memberPermissions === null) || await hasGrant(access.permCtx.userId, id, "production", "*", "meta/avatar", "edit"))) {
    return Response.json({ error: "无权限" }, { status: 403 });
  }

  const body = await req.json() as { mimeType?: string };
  const mimeType = body.mimeType;
  if (!mimeType || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) {
    return Response.json({ error: "不支持的文件类型" }, { status: 400 });
  }

  const r2Key = `avatars/production/${id}/avatar`;
  const { url } = presignedPut(r2Key, mimeType, 900);

  return Response.json({ uploadUrl: url, r2Key });
}
