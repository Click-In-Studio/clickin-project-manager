import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset, addUniversalAssetFile } from "@/lib/asset/db";
import { hasGrant } from "@/lib/grant-check";
import { completeMultipartUpload, listMultipartParts } from "@/lib/r2";
import { enqueueAssetPostProcess } from "@/lib/job/asset-jobs";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

/**
 * 同资产追加版本文件（#456 接线）。
 *
 * 与 assets POST 的 r2 / r2-multipart 分支同构：浏览器拿 presign 直传（或走
 * relay 中转）把字节送进 R2，完成后回来注册一行 asset_file。整文件不过 next
 * 内存——改造前这里收 FormData 把整个文件读成 Buffer，且全仓零调用方：UI 上
 * 的「上传新版本」打的是创建新资产的端点，追加版本从界面上不可达。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  // 批D：overwrite（新版本文件）= file@create（创建者行集承担 own 语义）
  if (!access.permCtx.isAdmin && !access.permCtx.isOwner && !await hasGrant(session.userId, id, "asset", assetId, "file", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (asset.storageType !== "r2") return Response.json({ error: "非 R2 文件，无法上传新版本" }, { status: 400 });

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json"))
    return Response.json({ error: "不支持的 Content-Type" }, { status: 415 });

  const body = (await req.json()) as {
    storageType?: "r2" | "r2-multipart";
    r2Key?: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    // r2-multipart only
    uploadId?: string;
  };

  if (!body.r2Key || !body.fileName)
    return Response.json({ error: "缺少 r2Key 或 fileName" }, { status: 400 });
  // r2Key 由 presign 端点铸造（assets/<fileId>/<name>）。这里只做前缀收敛，挡住
  // 把版本文件指向缩略图/sidecar/头像等他用 key；**不构成**归属校验——同前缀下
  // 别人的 key 仍能被写进来，与 assets 注册分支的既有暴露面等同（见 PR 说明）。
  if (!body.r2Key.startsWith("assets/"))
    return Response.json({ error: "非法的 r2Key" }, { status: 400 });

  const mimeType = body.mimeType ?? "application/octet-stream";
  const fileSize = body.fileSize ?? null;

  // 分段上传：ETag 一律服务端取——R2 的 CORS 不把 ETag 暴露给浏览器，
  // 客户端报上来的不可信（与 assets 路由同一处理）。
  if (body.storageType === "r2-multipart") {
    if (!body.uploadId) return Response.json({ error: "缺少 uploadId" }, { status: 400 });
    const parts = await listMultipartParts(body.r2Key, body.uploadId);
    await completeMultipartUpload(body.r2Key, body.uploadId, parts);
  }

  // 元数据跟着最新文件走（latest-wins 也作用于 asset 行），与文件行同事务
  const assetFile = await addUniversalAssetFile(assetId, body.r2Key, null, fileSize,
    { fileName: body.fileName, mimeType });
  // 缩略图/文档解析预热是异步任务（heavy-worker）——上传路径不再同步跑 sharp
  await enqueueAssetPostProcess({ assetFileId: assetFile.id, r2Key: body.r2Key, mimeType, fileName: body.fileName, fileSize });

  // 返回体与 assets POST 同构（{ asset, file }），调用方两条注册路径共用一套解析
  return Response.json({ asset: await getAsset(assetId), file: assetFile }, { status: 201 });
}
