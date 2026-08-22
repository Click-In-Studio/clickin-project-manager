import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset, resolveAssetFile } from "@/lib/asset-db";
import { presignedGet } from "@/lib/r2";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  if (asset.storageType === "feishu_link") {
    return Response.json({ url: asset.feishuUrl });
  }

  const file = await resolveAssetFile(assetId);
  if (!file?.r2Key) return Response.json({ error: "文件不存在" }, { status: 404 });

  const url = presignedGet(file.r2Key, 3600);
  return Response.json({ url, expiresIn: 3600 });
}
