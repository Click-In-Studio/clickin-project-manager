import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, canUserAccessProduction } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { createAsset, listAssets, type AssetType } from "@/lib/asset-db";
import { putR2Object, assetR2Key, thumbnailR2Key } from "@/lib/r2";
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

  // ── Feishu link ────────────────────────────────────────────────────────────
  if (ct.includes("application/json")) {
    const body = (await req.json()) as {
      storageType: "feishu_link";
      feishuUrl: string;
      assetType: AssetType;
      name?: string | null;
      fileName: string;
      isUniversal?: boolean;
      versionId?: string | null;
    };
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

  // ── File upload (multipart) ────────────────────────────────────────────────
  if (ct.includes("multipart/form-data")) {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return Response.json({ error: "缺少 file 字段" }, { status: 400 });

    const assetType = (formData.get("assetType") as AssetType | null) ?? "reference";
    const name = (formData.get("name") as string | null) || null;
    const isUniversal = formData.get("isUniversal") !== "false";
    const versionId = (formData.get("versionId") as string | null) ?? null;
    const mimeType = file.type || "application/octet-stream";
    const fileName = file.name;

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileId = `af_${Date.now().toString(36)}`;
    const r2Key = assetR2Key(fileId, fileName);

    let thumbKey: string | null = null;
    if (mimeType.startsWith("image/")) {
      const thumb = await sharp(buffer).resize(400, 400, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      thumbKey = thumbnailR2Key(fileId);
      await putR2Object(thumbKey, thumb, "image/webp");
    }

    await putR2Object(r2Key, buffer, mimeType);

    const { asset, file: assetFile } = await createAsset({
      productionId: id, uploaderOpenId: session.openId,
      assetType, name, fileName, mimeType, isUniversal, storageType: "r2",
      r2Key, thumbnailR2Key: thumbKey, fileSize: buffer.length, versionId,
    });
    return Response.json({ asset, file: assetFile }, { status: 201 });
  }

  return Response.json({ error: "不支持的 Content-Type" }, { status: 415 });
}
