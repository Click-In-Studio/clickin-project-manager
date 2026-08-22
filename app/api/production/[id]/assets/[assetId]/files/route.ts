import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset, addUniversalAssetFile } from "@/lib/asset-db";
import { hasGrant } from "@/lib/grant-check";
import { putR2Object, assetR2Key, thumbnailR2Key } from "@/lib/r2";
import sharp from "sharp";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

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

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return Response.json({ error: "缺少 file 字段" }, { status: 400 });

  const mimeType = file.type || "application/octet-stream";
  const buffer = Buffer.from(await file.arrayBuffer());
  const fileId = `af_${Date.now().toString(36)}`;
  const r2Key = assetR2Key(fileId, file.name);

  let thumbKey: string | null = null;
  if (mimeType.startsWith("image/")) {
    const thumb = await sharp(buffer)
      .resize(400, 400, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    thumbKey = thumbnailR2Key(fileId);
    await putR2Object(thumbKey, thumb, "image/webp");
  }
  await putR2Object(r2Key, buffer, mimeType);

  const assetFile = await addUniversalAssetFile(assetId, r2Key, thumbKey, buffer.length);

  return Response.json({ file: assetFile }, { status: 201 });
}
