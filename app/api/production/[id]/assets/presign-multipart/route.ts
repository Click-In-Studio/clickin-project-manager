import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { createMultipartUpload, presignedUploadPart, assetR2Key } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { fileName?: string; mimeType?: string; partCount?: number; fileSize?: number };
  if (!body.fileName || !body.mimeType || !body.partCount || body.partCount < 1)
    return Response.json({ error: "缺少 fileName / mimeType / partCount" }, { status: 400 });

  // Dynamic expiry: assume 1 MB/s worst-case speed, 3× safety factor, clamp 1h–12h
  const fileMB = (body.fileSize ?? 0) / (1024 * 1024);
  const expiresIn = Math.min(43200, Math.max(3600, Math.ceil(fileMB) * 3));

  const fileId = `af_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const r2Key = assetR2Key(fileId, body.fileName);

  const uploadId = await createMultipartUpload(r2Key, body.mimeType);

  const parts = Array.from({ length: body.partCount }, (_, i) => ({
    partNumber: i + 1,
    uploadUrl: presignedUploadPart(r2Key, uploadId, i + 1, expiresIn),
  }));

  return Response.json({ uploadId, r2Key, fileId, parts });
}
