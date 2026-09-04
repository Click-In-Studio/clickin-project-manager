import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
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
    const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
    if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

    const asset = await getAsset(assetId);
    if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

    const previewType = getPreviewType(asset.mimeType);
    if (!previewType) return Response.json({ error: "不支持预览" }, { status: 400 });

    if (asset.storageType === "feishu_link") {
      return Response.json({ previewType, url: asset.feishuUrl, mimeType: asset.mimeType });
    }

    const file = await resolveAssetFile(assetId);
    if (!file?.r2Key) return Response.json({ error: "文件不存在" }, { status: 404 });

    // cacheWindow：签名时间戳按小时对齐，同一小时内 URL 字节级相同，浏览器
    // 才能命中缓存（否则每次预览都是一次新的 R2 GET + 全量下载）；
    // cacheControl：R2 响应默认无缓存头，显式给 max-age 免掉重复回源验证
    const url = presignedGet(file.r2Key, 3600, {
      inline: true,
      contentType: asset.mimeType ?? undefined,
      cacheWindow: 3600,
      cacheControl: "private, max-age=3600",
    });

    return Response.json({ previewType, url, mimeType: asset.mimeType });
  } catch (e) {
    console.error("[preview-url] unhandled error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
