import { type NextRequest } from "next/server";
import { canUploadAssetBytes } from "@/lib/asset/perm";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { presignedPut } from "@/lib/r2";

// Fixed key — probe uploads always overwrite this object, no accumulation.
const PROBE_R2_KEY = "_internal/upload-speed-probe";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  // 与 presign / relay-part 同一把上传门（#605：此前错挂 script/*/blocks@view）。
  // 探针发生在选定目标之前，没有 assetId，按通配 create 判。
  if (!await canUploadAssetBytes(permCtx, id, null))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const { url } = presignedPut(PROBE_R2_KEY, "application/octet-stream", 120);
  return Response.json({ uploadUrl: url });
}
