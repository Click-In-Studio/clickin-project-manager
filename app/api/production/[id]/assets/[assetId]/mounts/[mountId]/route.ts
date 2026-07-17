import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";
import { getAsset, removeAssetMount, listAssetMounts } from "@/lib/asset-db";

type Ctx = { params: Promise<{ id: string; assetId: string; mountId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, assetId, mountId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.userId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  const mounts = await listAssetMounts(assetId);
  const mount = mounts.find(m => m.id === mountId);
  if (!mount) return Response.json({ error: "挂载点不存在" }, { status: 404 });

  const isOwner = asset.uploaderUserId === session.userId || mount.createdBy === session.userId;
  if (!isOwner && !session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  await removeAssetMount(mountId);
  return Response.json({ ok: true });
}
