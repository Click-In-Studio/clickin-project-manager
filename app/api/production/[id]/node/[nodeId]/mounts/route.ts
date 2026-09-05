import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { getNode } from "@/lib/node/db";
import { addNodeMount, validateMountTarget, type MountType } from "@/lib/node/mount";
import { canPublishAsset, mountHostSidePermitted } from "@/lib/asset/perm";
import { canShareWiki } from "@/lib/wiki/perm";

type Ctx = { params: Promise<{ id: string; nodeId: string }> };

// POST /api/production/[id]/node/[nodeId]/mounts   通用挂载边创建（#420 第二批）
//
// 挂载点四动作的「挂载文档」落点；asset 节点也受理（与 assets/[assetId]/mounts
// 同门同源，那条路由继续服务按 asset id 寻址的既有消费方）。
//
// 双门按 kind 分派（node 侧 ∧ 宿主侧）：
//   · asset → publication@create（主人侧让渡，批D 双门保真）
//   · wiki  → canShareWiki（grants@edit）——挂载让渡≡分享语义（PR #425 拍板），
//     把文档挂到宿主上就是把它分享给宿主受众，门与分享面同一把
//   · folder/link → 400（不可挂载）
// 宿主侧统一 mountHostSidePermitted。
//
// 'embed' 不受理：嵌入边属 wiki 正文管道（WikiDocClient → assets 路由），且
// wiki 嵌 wiki 不支持（host-visibility 判定核同款排除，进来会自递归）。

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, nodeId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const node = await getNode(nodeId, productionId);
  if (!node) return Response.json({ error: "节点不存在" }, { status: 404 });
  if (node.kind !== "asset" && node.kind !== "wiki")
    return Response.json({ error: "该类型节点不可挂载" }, { status: 400 });

  const body = (await req.json()) as {
    mountType: MountType; mountId: string; mountAuxId?: string | null;
  };
  if (!body.mountType || !body.mountId)
    return Response.json({ error: "缺少 mountType 或 mountId" }, { status: 400 });
  if (body.mountType === "embed")
    return Response.json({ error: "嵌入边请走文档正文管道" }, { status: 400 });

  const nodeSideOk = node.kind === "asset"
    ? await canPublishAsset(actor, productionId, node.assetId!, "create")
    : await canShareWiki(actor, productionId, node.wikiId!);
  if (!nodeSideOk || !await mountHostSidePermitted(actor, productionId, body.mountType, body.mountId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  if (!(await validateMountTarget(productionId, body.mountType, body.mountId)))
    return Response.json({ error: "挂载目标不存在" }, { status: 404 });

  const mount = await addNodeMount({
    nodeId: node.id, productionId,
    mountType: body.mountType, mountId: body.mountId,
    mountAuxId: body.mountAuxId,
    createdBy: session.userId,
  });
  return Response.json({ mount }, { status: 201 });
}
