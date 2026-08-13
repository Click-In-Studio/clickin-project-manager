import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
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
  if (!(permCtx.isAdmin || await hasGrant(permCtx.userId, id, "script", "*", "blocks", "view")))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const { url } = presignedPut(PROBE_R2_KEY, "application/octet-stream", 120);
  return Response.json({ uploadUrl: url });
}
