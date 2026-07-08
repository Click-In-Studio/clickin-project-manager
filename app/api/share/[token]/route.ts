import { type NextRequest } from "next/server";
import { verifyShareToken } from "@/lib/asset-share-token";
import { getAsset, getLatestAssetFile } from "@/lib/asset-db";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const payload = verifyShareToken(token);
  if (!payload) return Response.json({ error: "链接无效或已过期" }, { status: 404 });

  const asset = await getAsset(payload.aid);
  if (!asset) return Response.json({ error: "资产不存在" }, { status: 404 });

  const file = await getLatestAssetFile(payload.aid);

  return Response.json({
    assetId: asset.id,
    name: asset.name ?? asset.fileName,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: file?.fileSize ?? null,
    assetType: asset.assetType,
    storageType: asset.storageType,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    allowDownload: payload.dl,
  });
}
