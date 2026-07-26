import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getAsset } from "@/lib/asset-db";
import { signShareToken } from "@/lib/asset-share-token";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!hasPermission("script:view", permCtx))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id)
    return Response.json({ error: "资产不存在" }, { status: 404 });

  const body = await req.json() as { expiresInDays?: number; allowDownload?: boolean };
  const expiresInDays = Math.max(1, Math.min(365, body.expiresInDays ?? 30));
  const allowDownload = body.allowDownload ?? false;

  const exp = Math.floor(Date.now() / 1000) + expiresInDays * 86400;
  const token = signShareToken({ aid: assetId, pid: id, exp, dl: allowDownload });

  return Response.json({ token }, { status: 201 });
}
