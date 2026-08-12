import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset } from "@/lib/asset-db";
import { canCreateShareToken } from "@/lib/asset-perm";
import { signShareToken } from "@/lib/asset-share-token";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id)
    return Response.json({ error: "资产不存在" }, { status: 404 });

  // 批D：shares@create 门（原误用 script:view）；
  // 令牌下载能力规则："含下载 ⟺ 发令牌者持有 file@view"（不能分享自己没有的能力）
  const shareCap = await canCreateShareToken(permCtx, id, asset);
  if (!shareCap.allowed) return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { expiresInDays?: number; allowDownload?: boolean };
  const expiresInDays = Math.max(1, Math.min(365, body.expiresInDays ?? 30));
  const allowDownload = (body.allowDownload ?? false) && shareCap.downloadable;

  const exp = Math.floor(Date.now() / 1000) + expiresInDays * 86400;
  const token = signShareToken({ aid: assetId, pid: id, exp, dl: allowDownload });

  return Response.json({ token }, { status: 201 });
}
