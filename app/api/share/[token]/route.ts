import { type NextRequest } from "next/server";
import { getShareToken, consumeShareToken, isShareTokenValid } from "@/lib/asset-share-db";
import { getAsset, getLatestAssetFile } from "@/lib/asset-db";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const shareToken = await getShareToken(token);
  if (!shareToken || !isShareTokenValid(shareToken))
    return Response.json({ error: "链接无效或已过期" }, { status: 404 });

  // Consume one-time token on first access
  if (shareToken.oneTime && !shareToken.usedAt) {
    await consumeShareToken(token);
  }

  const asset = await getAsset(shareToken.assetId);
  if (!asset) return Response.json({ error: "资产不存在" }, { status: 404 });

  const file = await getLatestAssetFile(shareToken.assetId);

  return Response.json({
    assetId: asset.id,
    name: asset.name ?? asset.fileName,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: file?.fileSize ?? null,
    assetType: asset.assetType,
    storageType: asset.storageType,
    expiresAt: shareToken.expiresAt,
    oneTime: shareToken.oneTime,
  });
}
