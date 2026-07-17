import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";
import { getAsset, updateAsset, deleteAsset, type AssetType } from "@/lib/asset-db";
import { deleteR2Object } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

async function checkAccess(req: NextRequest, id: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, error: Response.json({ error: "未登录" }, { status: 401 }) };
  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) return { session: null, error: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { session, error: null };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const { session, error } = await checkAccess(req, id);
  if (!session) return error!;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });
  return Response.json({ asset });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const { session, error } = await checkAccess(req, id);
  if (!session) return error!;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  const isOwner = asset.uploaderOpenId === session.openId;
  if (!isOwner && !session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { assetType?: AssetType; name?: string | null; fileName?: string };
  const updated = await updateAsset(assetId, body);
  return Response.json({ asset: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const { session, error } = await checkAccess(req, id);
  if (!session) return error!;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  const isOwner = asset.uploaderOpenId === session.openId;
  if (!isOwner && !session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const { r2Keys } = await deleteAsset(assetId);
  await Promise.allSettled(r2Keys.map(k => deleteR2Object(k)));
  return Response.json({ ok: true });
}
