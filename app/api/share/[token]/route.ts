import { type NextRequest } from "next/server";
import { verifyShareToken } from "@/lib/asset/share-token";
import { getAsset, getLatestAssetFile } from "@/lib/asset/db";
import { isPolicyOn } from "@/lib/policy-db";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const payload = verifyShareToken(token);
  if (!payload) return Response.json({ error: "链接无效或已过期" }, { status: 404 });

  const asset = await getAsset(payload.aid);
  if (!asset) return Response.json({ error: "资产不存在" }, { status: 404 });

  // #236 出口开关：**兑现端也要读**。令牌是签名载荷不是库里的行，撤不掉；
  // 只改发放端等于「关出口」半截生效——已发出去的链接照样能用。两处同读，
  // 关掉即刻停发新链接 + 已发链接同时失效（形状 C 天然追溯）。
  if (!await isPolicyOn(asset.productionId, "policy.share_token_enabled")) {
    return Response.json({ error: "链接无效或已过期" }, { status: 404 });
  }

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
