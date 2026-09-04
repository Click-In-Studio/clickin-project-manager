import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { filterVisibleAssets } from "@/lib/asset/perm";
import { hasGrant } from "@/lib/grant-check";
import { createAsset, listAssets, type AssetType } from "@/lib/asset/db";
import { isAssetType } from "@/lib/asset/types";
import { putR2Object, getR2Object, thumbnailR2Key, completeMultipartUpload, listMultipartParts } from "@/lib/r2";
import sharp from "sharp";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const assets = await listAssets(id);
  // 批D：可见性过滤（能力票∧结构 ∨ publication@view）
  const visible = await filterVisibleAssets(access.permCtx, id, assets);
  return Response.json({ assets: visible });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });
  // 批D：上传 = asset/*@create（原为裸门，按名义键收紧，与批A GET 补门先例一致）
  if (!session.isAdmin && !access.permCtx.isOwner && !await hasGrant(session.userId, id, "asset", "*", "*", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const ct = req.headers.get("content-type") ?? "";

  // ── JSON body: feishu link OR pre-uploaded R2 registration ─────────────────
  if (ct.includes("application/json")) {
    const body = (await req.json()) as {
      storageType: "feishu_link" | "r2" | "r2-multipart";
      // feishu fields
      feishuUrl?: string;
      // r2 pre-upload fields
      r2Key?: string;
      fileId?: string;
      mimeType?: string;
      fileSize?: number;
      // r2-multipart extra fields
      uploadId?: string;
      parts?: { partNumber: number; eTag: string }[];
      // shared
      assetType: AssetType;
      name?: string | null;
      fileName: string;
    };

    // asset_type 列无 CHECK 约束，白名单只在 TS 层——运行时校验防任意串入库
    if (body.assetType !== undefined && !isAssetType(body.assetType))
      return Response.json({ error: "无效的资产类型" }, { status: 400 });

    if (body.storageType === "r2-multipart") {
      if (!body.r2Key || !body.fileId || !body.fileName || !body.uploadId || !Array.isArray(body.parts))
        return Response.json({ error: "缺少 r2Key / fileId / fileName / uploadId / parts" }, { status: 400 });

      // Fetch real ETags server-side — client-provided ETags are unreliable because
      // R2 CORS does not expose the ETag response header to browsers.
      const parts = await listMultipartParts(body.r2Key, body.uploadId);
      await completeMultipartUpload(body.r2Key, body.uploadId, parts);

      const mimeType = body.mimeType ?? "application/octet-stream";
      let thumbKey: string | null = null;
      if (mimeType.startsWith("image/")) {
        const obj = await getR2Object(body.r2Key);
        if (obj) {
          const thumb = await sharp(obj.body)
            .resize(400, 400, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
          thumbKey = thumbnailR2Key(body.fileId);
          await putR2Object(thumbKey, thumb, "image/webp");
        }
      }

      const { asset, file } = await createAsset({
        productionId: id, uploaderUserId: session.userId,
        assetType: body.assetType ?? "reference", name: body.name ?? null,
        fileName: body.fileName, mimeType,
        storageType: "r2", r2Key: body.r2Key, thumbnailR2Key: thumbKey,
        fileSize: body.fileSize ?? null,
      });
      return Response.json({ asset, file }, { status: 201 });
    }

    if (body.storageType === "r2") {
      if (!body.r2Key || !body.fileId || !body.fileName)
        return Response.json({ error: "缺少 r2Key / fileId / fileName" }, { status: 400 });

      const mimeType = body.mimeType ?? "application/octet-stream";
      let thumbKey: string | null = null;
      if (mimeType.startsWith("image/")) {
        const obj = await getR2Object(body.r2Key);
        if (obj) {
          const thumb = await sharp(obj.body)
            .resize(400, 400, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
          thumbKey = thumbnailR2Key(body.fileId);
          await putR2Object(thumbKey, thumb, "image/webp");
        }
      }

      const { asset, file } = await createAsset({
        productionId: id, uploaderUserId: session.userId,
        assetType: body.assetType ?? "reference", name: body.name ?? null,
        fileName: body.fileName, mimeType,
        storageType: "r2", r2Key: body.r2Key, thumbnailR2Key: thumbKey,
        fileSize: body.fileSize ?? null,
      });
      return Response.json({ asset, file }, { status: 201 });
    }

    // feishu_link
    if (!body.feishuUrl || !body.fileName)
      return Response.json({ error: "缺少 feishuUrl 或 fileName" }, { status: 400 });

    const { asset, file } = await createAsset({
      productionId: id, uploaderUserId: session.userId,
      assetType: body.assetType ?? "reference", name: body.name ?? null,
      fileName: body.fileName, mimeType: null,
      storageType: "feishu_link", feishuUrl: body.feishuUrl,
    });
    return Response.json({ asset, file }, { status: 201 });
  }

  return Response.json({ error: "不支持的 Content-Type" }, { status: 415 });
}
