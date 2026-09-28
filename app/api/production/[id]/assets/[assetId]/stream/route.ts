import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getAsset, resolveAssetFile } from "@/lib/asset/db";
import { canViewAsset } from "@/lib/asset/perm";
import { getR2Stream } from "@/lib/r2";

/** 站内预览流：每次请求（含 Range）都重查当前内容门，不签发可带走的 R2 URL。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return new Response("未登录", { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return new Response("权限不足", { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return new Response("不存在", { status: 404 });
  if (!await canViewAsset(access.permCtx, id, asset, "meta"))
    return new Response("权限不足", { status: 403 });
  if (asset.assetType === "financial_document")
    return new Response("财务凭证请从报销单查看", { status: 403 });
  if (asset.storageType !== "r2") return new Response("非 R2 文件", { status: 400 });

  const file = await resolveAssetFile(assetId);
  if (!file?.r2Key) return new Response("文件不存在", { status: 404 });
  const range = req.headers.get("range");
  const source = await getR2Stream(file.r2Key, range);
  if (!source) return new Response("文件不存在", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", asset.mimeType ?? source.headers.get("content-type") ?? "application/octet-stream");
  headers.set("Content-Disposition", "inline");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  const contentRange = source.headers.get("content-range");
  if (contentRange) headers.set("Content-Range", contentRange);
  const contentLength = source.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  return new Response(source.body, { status: range ? 206 : 200, headers });
}
