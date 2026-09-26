import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { getAsset } from "@/lib/asset/db";
import { getNodeByAssetId, setNodePublic, setNodeListable, setNodeDeptShares, listNodeDeptShares } from "@/lib/node/db";
import { listAssetSharePeople, addAssetSharePerson, removeAssetSharePerson } from "@/lib/asset/share-db";
import { kickRevokedStreams } from "@/lib/perm/revoke-streams";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

async function guard(req: NextRequest, ctx: Ctx) {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return { err: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return { err: Response.json({ error: "无权访问" }, { status: 403 }) };
  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id)
    return { err: Response.json({ error: "资产不存在" }, { status: 404 }) };
  const shell = await getNodeByAssetId(assetId);
  if (!shell || shell.productionId !== id)
    return { err: Response.json({ error: "资产节点不存在" }, { status: 404 }) };
  if (!await hasEffectiveGrant(access.permCtx, id, "asset", assetId, "grants", "edit"))
    return { err: Response.json({ error: "权限不足（分享面）" }, { status: 403 }) };
  return { id, assetId, session, access, shell };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const g = await guard(req, ctx);
  if (g.err) return g.err;
  return Response.json({
    isPublic: g.shell!.isPublic,
    listable: g.shell!.listable,
    deptIds: await listNodeDeptShares(g.shell!.id),
    people: await listAssetSharePeople(g.assetId!, g.id!),
  });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const g = await guard(req, ctx);
  if (g.err) return g.err;
  if (g.access!.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const body = await req.json() as {
    isPublic?: boolean; listable?: boolean; deptIds?: string[];
    addPerson?: { userId: string; canDownload?: boolean };
    removePersonUserId?: string;
  };
  if (body.isPublic !== undefined && typeof body.isPublic !== "boolean")
    return Response.json({ error: "无效的公开设置" }, { status: 400 });
  if (body.listable !== undefined && typeof body.listable !== "boolean")
    return Response.json({ error: "无效的列出设置" }, { status: 400 });
  if (body.deptIds !== undefined && (!Array.isArray(body.deptIds) || !body.deptIds.every(x => typeof x === "string")))
    return Response.json({ error: "无效的部门列表" }, { status: 400 });
  if (body.addPerson && (typeof body.addPerson.userId !== "string"
      || (body.addPerson.canDownload !== undefined && typeof body.addPerson.canDownload !== "boolean")))
    return Response.json({ error: "无效的分享对象" }, { status: 400 });
  if (body.removePersonUserId !== undefined && typeof body.removePersonUserId !== "string")
    return Response.json({ error: "无效的移除对象" }, { status: 400 });
  const actionCount = [body.isPublic, body.listable, body.deptIds, body.addPerson, body.removePersonUserId]
    .filter(x => x !== undefined).length;
  if (actionCount !== 1) return Response.json({ error: "每次只能修改一项分享设置" }, { status: 400 });
  const shell = g.shell!;
  if (body.isPublic !== undefined) await setNodePublic(shell.id, g.id!, body.isPublic);
  if (body.listable !== undefined) await setNodeListable(shell.id, g.id!, body.listable);
  if (body.deptIds !== undefined) await setNodeDeptShares(shell.id, g.id!, body.deptIds);
  if (body.isPublic === false || body.deptIds !== undefined) kickRevokedStreams(g.id!);
  if (body.addPerson) {
    const result = await addAssetSharePerson(g.assetId!, g.id!, {
      userId: body.addPerson.userId,
      canDownload: body.addPerson.canDownload === true,
      confirmedBy: g.session!.userId,
    });
    if (result === "not_member") return Response.json({ error: "对方不是本项目成员" }, { status: 400 });
  }
  if (body.removePersonUserId) {
    await removeAssetSharePerson(g.assetId!, g.id!, body.removePersonUserId);
    kickRevokedStreams(g.id!, body.removePersonUserId);
  }
  return Response.json({ ok: true });
}
