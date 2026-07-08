import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { revokeShareToken } from "@/lib/asset-share-db";

type Ctx = { params: Promise<{ id: string; assetId: string; tokenId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, assetId, tokenId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const ok = await revokeShareToken(tokenId, assetId);
  if (!ok) return Response.json({ error: "Token 不存在或已失效" }, { status: 404 });
  return Response.json({ ok: true });
}
