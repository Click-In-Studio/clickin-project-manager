import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";
import { getAsset, resolveAssetFile } from "@/lib/asset-db";
import { presignedGet } from "@/lib/r2";

function getPreviewType(mimeType: string | null): "image" | "video" | "audio" | "pdf" | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  try {
    const { id, assetId } = await ctx.params;
    const session = getSession(req.cookies);
    if (!session) return Response.json({ error: "未登录" }, { status: 401 });
    const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
    if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

    const asset = await getAsset(assetId);
    if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

    const previewType = getPreviewType(asset.mimeType);
    if (!previewType) return Response.json({ error: "不支持预览" }, { status: 400 });

    if (asset.storageType === "feishu_link") {
      return Response.json({ previewType, url: asset.feishuUrl, mimeType: asset.mimeType });
    }

    const versionId = req.nextUrl.searchParams.get("v") ?? undefined;
    const file = await resolveAssetFile(assetId, versionId);
    if (!file?.r2Key) return Response.json({ error: "文件不存在" }, { status: 404 });

    const url = presignedGet(file.r2Key, 3600, {
      inline: true,
      contentType: asset.mimeType ?? undefined,
    });

    return Response.json({ previewType, url, mimeType: asset.mimeType });
  } catch (e) {
    console.error("[preview-url] unhandled error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
