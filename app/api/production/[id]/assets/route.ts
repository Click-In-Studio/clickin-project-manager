import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, canUserAccessProduction } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { createAsset, listAssets, type AssetType } from "@/lib/asset-db";
import { putR2Object, getR2Object, thumbnailR2Key, completeMultipartUpload } from "@/lib/r2";
import sharp from "sharp";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const assets = await listAssets(id);
  return Response.json({ assets });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
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
      isUniversal?: boolean;
      versionId?: string | null;
    };

    if (body.storageType === "r2-multipart") {
      if (!body.r2Key || !body.fileId || !body.fileName || !body.uploadId || !Array.isArray(body.parts))
        return Response.json({ error: "缺少 r2Key / fileId / fileName / uploadId / parts" }, { status: 400 });

      await completeMultipartUpload(body.r2Key, body.uploadId, body.parts);

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
        productionId: id, uploaderOpenId: session.openId,
        assetType: body.assetType ?? "reference", name: body.name ?? null,
        fileName: body.fileName, mimeType, isUniversal: body.isUniversal ?? true,
        storageType: "r2", r2Key: body.r2Key, thumbnailR2Key: thumbKey,
        fileSize: body.fileSize ?? null, versionId: body.versionId ?? null,
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
        productionId: id, uploaderOpenId: session.openId,
        assetType: body.assetType ?? "reference", name: body.name ?? null,
        fileName: body.fileName, mimeType, isUniversal: body.isUniversal ?? true,
        storageType: "r2", r2Key: body.r2Key, thumbnailR2Key: thumbKey,
        fileSize: body.fileSize ?? null, versionId: body.versionId ?? null,
      });
      return Response.json({ asset, file }, { status: 201 });
    }

    // feishu_link
    if (!body.feishuUrl || !body.fileName)
      return Response.json({ error: "缺少 feishuUrl 或 fileName" }, { status: 400 });

    const { asset, file } = await createAsset({
      productionId: id, uploaderOpenId: session.openId,
      assetType: body.assetType ?? "reference", name: body.name ?? null,
      fileName: body.fileName, mimeType: null, isUniversal: body.isUniversal ?? true,
      storageType: "feishu_link", feishuUrl: body.feishuUrl,
      versionId: body.versionId ?? null,
    });
    return Response.json({ asset, file }, { status: 201 });
  }

  return Response.json({ error: "不支持的 Content-Type" }, { status: 415 });
}
