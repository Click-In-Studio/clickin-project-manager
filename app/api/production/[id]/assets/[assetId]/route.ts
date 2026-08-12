import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset, updateAsset, deleteAsset, type AssetType } from "@/lib/asset-db";
import { canViewAsset } from "@/lib/asset-perm";
import { hasGrant } from "@/lib/grant-check";
import { getProductionPermissionContext as getPermCtx } from "@/lib/db";
import { deleteR2Object } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

async function checkAccess(req: NextRequest, id: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, error: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return { session: null, error: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { session, error: null };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const { session, error } = await checkAccess(req, id);
  if (!session) return error!;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });
  const acc = await getPermCtx(session.userId, session.isAdmin, id);
  if (!acc || !await canViewAsset(acc.permCtx, id, asset, "meta"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ asset });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const { session, error } = await checkAccess(req, id);
  if (!session) return error!;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  // 批D：rename/change_type = meta@edit（创建者行集承担 own 语义）
  if (!session.isAdmin && !await hasGrant(session.userId, id, "asset", assetId, "meta", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

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
  // 批D：delete = 实例 delete 行（创建者行集/delete_any 通配承担）
  if (!session.isAdmin && !await hasGrant(session.userId, id, "asset", assetId, "*", "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const isOwner = asset.uploaderUserId === session.userId;
  if (!isOwner && !session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const { r2Keys } = await deleteAsset(assetId);
  await Promise.allSettled(r2Keys.map(k => deleteR2Object(k)));
  return Response.json({ ok: true });
}
