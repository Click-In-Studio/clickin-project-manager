import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { presignedPut } from "@/lib/r2";

// Fixed key — probe uploads always overwrite this object, no accumulation.
const PROBE_R2_KEY = "_internal/upload-speed-probe";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const { url } = presignedPut(PROBE_R2_KEY, "application/octet-stream", 120);
  return Response.json({ uploadUrl: url });
}
