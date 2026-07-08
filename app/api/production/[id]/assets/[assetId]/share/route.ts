import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getAsset } from "@/lib/asset-db";
import { createShareToken, listShareTokens } from "@/lib/asset-share-db";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const tokens = await listShareTokens(assetId);
  return Response.json({ tokens });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id)
    return Response.json({ error: "资产不存在" }, { status: 404 });

  const body = await req.json() as {
    type?: "time_limited" | "one_time";
    expiresInDays?: number | null;
    label?: string | null;
  };

  const type = body.type ?? "time_limited";
  const expiresInDays = type === "time_limited" ? (body.expiresInDays ?? 30) : null;

  const token = await createShareToken({
    assetId,
    productionId: id,
    createdBy: session.openId,
    label: body.label ?? null,
    type,
    expiresInDays,
  });

  return Response.json({ token }, { status: 201 });
}
