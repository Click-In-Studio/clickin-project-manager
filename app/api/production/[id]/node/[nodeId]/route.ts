import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasGrant, toActor } from "@/lib/grant-check";
import { getNode, moveNode, setNodeListable, type NodePlacement } from "@/lib/node/db";
import { canPlaceNodeUnder, canWriteNodeContainer } from "@/lib/node/perm";
import { canEditWiki } from "@/lib/wiki/perm";
import { canPublishAsset } from "@/lib/asset/perm";
import { readPlacement, readTrimmedId } from "@/lib/wiki/input";

type Ctx = { params: Promise<{ id: string; nodeId: string }> };

// PATCH /api/production/[id]/node/[nodeId]   通用节点位置面（folder/asset/wiki）
//
// wiki 内容的读写仍走 /wiki/[wikiId]（内容面），link 走 /wiki-alias/[id]——本路由
// 只管**壳节点的位置与树面开关**，是「把 PDF 拖进灵感库」这类跨 kind 操作的落点。
//
// 位置面三道门与 wiki 移动同源：目标父可枚举 ∧ 目标父容器可写 ∧（换父时）源父
// 容器可写。本体门按 kind：wiki→canEditWiki；asset→asset/<id>/meta@edit（上传者
// 行集含之）；folder→无主，容器写门已覆盖（批一 folder 全是系统产物）。
//
// listable（树面开关）仅对 asset 节点开放：接的是原「项目全局挂载」面板的语义
// （production mount ≡ 可枚举，#420），门保真平移＝publication@create/delete
// （主人侧让渡）∧ production/*/mounts@create（宿主侧）。wiki 的 listable 属分享
// 面，走 share 路由的 grants@edit 门，别在这里开第二个口径。

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, nodeId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const node = await getNode(nodeId, productionId);
  if (!node) return Response.json({ error: "节点不存在" }, { status: 404 });
  if (node.kind === "link")
    return Response.json({ error: "软链接请走 wiki-alias 路由" }, { status: 400 });

  const body = await req.json() as Record<string, unknown>;
  const changingParent = body.parentId !== undefined;
  const targetParentId = changingParent ? readTrimmedId(body.parentId) : node.parentId;
  const place = readPlacement(body.place) as NodePlacement | null;
  const listable = typeof body.listable === "boolean" ? body.listable : undefined;
  const movingPosition = changingParent || place !== null;

  if (listable !== undefined) {
    if (node.kind !== "asset" || !node.assetId)
      return Response.json({ error: "该节点的可枚举性不在本路由管理" }, { status: 400 });
    const permitted = actor.isAdmin || actor.isOwner
      || (await canPublishAsset(access.permCtx, productionId, node.assetId, listable ? "create" : "delete")
          && await hasGrant(session.userId, productionId, "production", "*", "mounts", "create"));
    if (!permitted) return Response.json({ error: "权限不足" }, { status: 403 });
    await setNodeListable(nodeId, productionId, listable);
    if (!movingPosition) return Response.json({ node: await getNode(nodeId, productionId) });
  }

  if (!movingPosition) return Response.json({ node });

  // 本体门（对被移动节点自身的权利）
  if (node.kind === "wiki" && node.wikiId) {
    if (!await canEditWiki(actor, productionId, node.wikiId))
      return Response.json({ error: "权限不足" }, { status: 403 });
  } else if (node.kind === "asset" && node.assetId) {
    if (!(actor.isAdmin || actor.isOwner
        || await hasGrant(session.userId, productionId, "asset", node.assetId, "meta", "edit")))
      return Response.json({ error: "权限不足" }, { status: 403 });
  }
  // 位置面三道门
  if (!await canPlaceNodeUnder(actor, productionId, targetParentId))
    return Response.json({ error: "无权移动到该父节点下" }, { status: 403 });
  if (!await canWriteNodeContainer(actor, productionId, targetParentId))
    return Response.json({ error: "无权修改该父节点的子目录" }, { status: 403 });
  if (changingParent && targetParentId !== node.parentId
      && !await canWriteNodeContainer(actor, productionId, node.parentId))
    return Response.json({ error: "无权把节点移出原父节点" }, { status: 403 });

  try {
    const moved = await moveNode(nodeId, productionId, {
      ...(changingParent ? { parentId: targetParentId } : {}),
      ...(place ? { place } : {}),
    });
    return Response.json({ node: moved });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "移动失败" }, { status: 400 });
  }
}
