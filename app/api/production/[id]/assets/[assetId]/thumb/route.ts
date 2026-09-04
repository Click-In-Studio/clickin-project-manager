import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset, resolveAssetFile } from "@/lib/asset/db";
import { canViewAsset } from "@/lib/asset/perm";
import { getR2Stream } from "@/lib/r2";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return new Response("未登录", { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return new Response("权限不足", { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return new Response("不存在", { status: 404 });
  if (!await canViewAsset(access.permCtx, id, asset, "meta")) return new Response("权限不足", { status: 403 });
  if (asset.storageType !== "r2") return new Response("非 R2 文件", { status: 400 });

  const file = await resolveAssetFile(assetId);
  if (!file?.thumbnailR2Key) return new Response("无缩略图", { status: 404 });

  // 流式转发（不整块 buffer 进内存）。带 ?v=（文件版本）的请求可 immutable：
  // 换文件即换 v；不带 v 的调用点（如 wiki 内嵌图初始缩略）只给短缓存。
  // 响应是 session 鉴权的，缓存必须 private。
  const obj = await getR2Stream(file.thumbnailR2Key);
  if (!obj) return new Response("文件不存在", { status: 404 });

  const versioned = req.nextUrl.searchParams.has("v");
  return new Response(obj.body, {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": versioned ? "private, max-age=31536000, immutable" : "private, max-age=3600",
    },
  });
}
