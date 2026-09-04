import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset, updateAsset, deleteAsset } from "@/lib/asset/db";
import { isAssetType } from "@/lib/asset/types";
import { canViewAsset } from "@/lib/asset/perm";
import { hasGrant } from "@/lib/grant-check";
import { deleteR2Object } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

async function checkAccess(req: NextRequest, id: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, permCtx: null, error: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return { session: null, permCtx: null, error: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { session, permCtx: access.permCtx, error: null };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const { session, permCtx, error } = await checkAccess(req, id);
  if (!session) return error!;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });
  if (!await canViewAsset(permCtx!, id, asset, "meta"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ asset });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const { session, permCtx, error } = await checkAccess(req, id);
  if (!session) return error!;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  // 批D：rename/change_type = meta@edit（创建者行集承担 own 语义）
  if (!session.isAdmin && !permCtx?.isOwner && !await hasGrant(session.userId, id, "asset", assetId, "meta", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { assetType?: unknown; name?: unknown; fileName?: unknown };
  // asset_type 列无 CHECK 约束，白名单只在 TS 层——这里必须运行时校验，否则任意串入库
  if (body.assetType !== undefined && !isAssetType(body.assetType))
    return Response.json({ error: "无效的资产类型" }, { status: 400 });
  if (body.name !== undefined && body.name !== null && typeof body.name !== "string")
    return Response.json({ error: "无效的显示名称" }, { status: 400 });
  if (body.fileName !== undefined && (typeof body.fileName !== "string" || !body.fileName.trim()))
    return Response.json({ error: "文件名不能为空" }, { status: 400 });

  const updated = await updateAsset(assetId, {
    assetType: body.assetType,
    // 显示名去空白，空串视同清除（回落 file_name）
    name: typeof body.name === "string" ? (body.name.trim() || null) : body.name,
    fileName: typeof body.fileName === "string" ? body.fileName.trim() : undefined,
  });
  return Response.json({ asset: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const { session, permCtx, error } = await checkAccess(req, id);
  if (!session) return error!;

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });
  // 批D：delete = 实例 delete 行（创建者行集/delete_any 通配承担）
  if (!session.isAdmin && !permCtx?.isOwner && !await hasGrant(session.userId, id, "asset", assetId, "*", "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const { r2Keys } = await deleteAsset(assetId);
  await Promise.allSettled(r2Keys.map(k => deleteR2Object(k)));
  return Response.json({ ok: true });
}
