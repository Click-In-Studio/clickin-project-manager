import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction, getVersion } from "@/lib/db";
import { getAsset, resolveAssetFile } from "@/lib/asset-db";
import { getR2Object } from "@/lib/r2";

async function validateVersion(productionId: string, versionId?: string | null) {
  if (!versionId) return true;
  const version = await getVersion(versionId);
  return version?.productionId === productionId;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return new Response("未登录", { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) return new Response("权限不足", { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return new Response("不存在", { status: 404 });
  if (asset.storageType !== "r2") return new Response("非 R2 文件", { status: 400 });

  const versionId = req.nextUrl.searchParams.get("v") ?? undefined;
  if (!(await validateVersion(id, versionId))) {
    return new Response("版本不存在", { status: 404 });
  }
  const file = await resolveAssetFile(assetId, versionId);
  if (!file?.thumbnailR2Key) return new Response("无缩略图", { status: 404 });

  const obj = await getR2Object(file.thumbnailR2Key);
  if (!obj) return new Response("文件不存在", { status: 404 });

  return new Response(new Uint8Array(obj.body), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
