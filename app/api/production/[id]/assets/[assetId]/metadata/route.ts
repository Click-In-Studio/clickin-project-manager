import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset, resolveAssetFile } from "@/lib/asset/db";
import { canViewAsset } from "@/lib/asset/perm";
import { getOrExtractFileMetadata } from "@/lib/asset/metadata";
import { TransientReadError } from "@/lib/asset/byte-source";

/**
 * #85 元数据读面：latest file（latest-wins，与 preview/download 同口径）的信封。
 * 懒轨触发点就在这里——首次请求就地分析写回，之后走 DB 缓存（文件行不可变，
 * 信封只在分析器/broker 版本升级时重算）。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });
  if (!await canViewAsset(access.permCtx, id, asset, "meta"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (asset.storageType !== "r2") return Response.json({ fileId: null, fileSize: null, metadata: null });

  const file = await resolveAssetFile(assetId);
  if (!file) return Response.json({ fileId: null, fileSize: null, metadata: null });

  try {
    const metadata = await getOrExtractFileMetadata(file, asset.fileName);
    return Response.json({ fileId: file.id, fileSize: file.fileSize, metadata });
  } catch (e) {
    // 只降级瞬态读失败（R2 网络类）：回旧信封/空，不落盘，下次请求重试
    // （avatar-serve 同款「显示不空窗」）。其余异常是管线 bug——确定性失败
    // 本应在 getOrExtractFileMetadata 内落成 failed 信封返回，到得了这里的
    // 一律 500 暴露出来，不许静默降级把 bug 埋掉（UI 对非 2xx 自会不显示）。
    if (e instanceof TransientReadError) {
      console.warn(`[asset-metadata] transient read failed (${file.id}):`, e);
      return Response.json({ fileId: file.id, fileSize: file.fileSize, metadata: file.metadata });
    }
    console.error(`[asset-metadata] pipeline error (${file.id}):`, e);
    return Response.json({ error: "元数据分析失败" }, { status: 500 });
  }
}
