import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { presignedPut, assetR2Key } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!hasPermission("script:view", permCtx))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { fileName?: string; mimeType?: string };
  if (!body.fileName || !body.mimeType)
    return Response.json({ error: "缺少 fileName 或 mimeType" }, { status: 400 });

  const fileId = `af_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const r2Key = assetR2Key(fileId, body.fileName);
  const { url, contentType } = presignedPut(r2Key, body.mimeType, 3600);

  return Response.json({ uploadUrl: url, r2Key, fileId, contentType });
}
