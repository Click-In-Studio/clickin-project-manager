import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { presignedUploadPart } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/production/[id]/assets/presign-part
 * Returns a presigned UploadPart URL for a single multipart chunk.
 * Called by the adaptive upload scheduler for on-demand part signing.
 *
 * Query params: r2Key, uploadId, partNumber (1–10000)
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(
    session.openId, session.isAdmin, id,
  );
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const r2Key      = sp.get("r2Key");
  const uploadId   = sp.get("uploadId");
  const partNumber = parseInt(sp.get("partNumber") ?? "0", 10);

  if (!r2Key || !uploadId || !partNumber || partNumber < 1 || partNumber > 10_000)
    return Response.json({ error: "缺少或非法参数 (r2Key / uploadId / partNumber)" }, { status: 400 });

  // 1-hour expiry — enough for a single 64 MB chunk at 1 MB/s worst-case
  const uploadUrl = presignedUploadPart(r2Key, uploadId, partNumber, 3600);
  return Response.json({ uploadUrl });
}
