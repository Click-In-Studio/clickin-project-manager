import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAsset } from "@/lib/asset/db";
import { getNodeByAssetId } from "@/lib/node/db";
import { addNodeMount, listNodeMounts, validateMountTarget, type MountType } from "@/lib/node/mount";
import { canViewAsset, canPublishAsset, mountHostSidePermitted } from "@/lib/asset/perm";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });
  if (!await canViewAsset(access.permCtx, id, asset, "meta"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const shell = await getNodeByAssetId(assetId);
  const mounts = shell ? await listNodeMounts(shell.id) : [];
  return Response.json({ mounts });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) return Response.json({ error: "不存在" }, { status: 404 });

  const body = (await req.json()) as {
    mountType: MountType;
    mountId: string;
    mountAuxId?: string | null;
  };

  if (!body.mountType || !body.mountId)
    return Response.json({ error: "缺少 mountType 或 mountId" }, { status: 400 });

  // 批D 双门：挂载 = asset publication@create（主人侧让渡）∧ 宿主侧 attach
  if (!await canPublishAsset(access.permCtx, id, assetId, "create")
      || !await mountHostSidePermitted(access.permCtx, id, body.mountType, body.mountId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  if (!(await validateMountTarget(id, body.mountType, body.mountId))) {
    return Response.json({ error: "挂载目标不存在" }, { status: 404 });
  }

  const shell = await getNodeByAssetId(assetId);
  if (!shell || shell.productionId !== id)
    return Response.json({ error: "不存在" }, { status: 404 });

  const mount = await addNodeMount({
    nodeId: shell.id, productionId: id,
    mountType: body.mountType, mountId: body.mountId,
    mountAuxId: body.mountAuxId,
    createdBy: session.userId,
  });
  return Response.json({ mount }, { status: 201 });
}
