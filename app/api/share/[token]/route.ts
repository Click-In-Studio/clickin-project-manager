import { type NextRequest } from "next/server";
import { getAssetShareLinkAccess, SHARE_SESSION_COOKIE, touchAssetShareSession } from "@/lib/asset/share-link-db";
import { getAsset, getLatestAssetFile } from "@/lib/asset/db";
import { isPolicyOn } from "@/lib/perm/policy-db";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const access = await getAssetShareLinkAccess(token, _req.cookies.get(SHARE_SESSION_COOKIE)?.value);
  if (access.kind === "invalid") {
    return Response.json({ error: "链接无效或已过期" }, { status: 404 });
  }
  if (!await isPolicyOn(access.link.productionId, "policy.share_token_enabled")) {
    return Response.json({ error: "链接无效或已过期" }, { status: 404 });
  }
  if (access.kind === "requires_redemption") {
    return Response.json({ requiresRedemption: true });
  }
  await touchAssetShareSession(access.link);

  const asset = await getAsset(access.link.assetId);
  if (!asset || asset.productionId !== access.link.productionId)
    return Response.json({ error: "资产不存在" }, { status: 404 });

  const file = await getLatestAssetFile(access.link.assetId);

  return Response.json({
    assetId: asset.id,
    name: asset.name ?? asset.fileName,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: file?.fileSize ?? null,
    assetType: asset.assetType,
    storageType: asset.storageType,
    expiresAt: access.link.expiresAt.toISOString(),
    allowDownload: access.link.allowDownload,
    oneTime: access.link.oneTime,
  });
}
