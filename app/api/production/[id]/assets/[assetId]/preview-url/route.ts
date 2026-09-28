import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getAsset, resolveAssetFile } from "@/lib/asset/db";
import { canViewAsset } from "@/lib/asset/perm";

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
    // 预览面=meta（与 thumb 同口径）：全尺寸预签名 URL 不能比缩略图松——此前只查
    // 成员身份，无票成员可绕过 canViewAsset 拿原件 URL
    if (!await canViewAsset(access.permCtx, id, asset, "meta"))
      return Response.json({ error: "权限不足" }, { status: 403 });
    if (asset.assetType === "financial_document")
      return Response.json({ error: "财务凭证请从报销单查看" }, { status: 403 });

    const previewType = getPreviewType(asset.mimeType);
    if (!previewType) return Response.json({ error: "不支持预览" }, { status: 400 });

    if (asset.storageType === "feishu_link")
      return Response.json({ error: "飞书链接不支持站内预览" }, { status: 400 });

    const file = await resolveAssetFile(assetId);
    if (!file?.r2Key) return Response.json({ error: "文件不存在" }, { status: 404 });

    // 浏览器只拿站内鉴权流地址，不再取得可脱离 session 使用的 R2 原件预签名 URL。
    return Response.json({
      previewType,
      url: `/api/production/${id}/assets/${assetId}/stream`,
      mimeType: asset.mimeType,
    });
  } catch (e) {
    console.error("[preview-url] unhandled error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
