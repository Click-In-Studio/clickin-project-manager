import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { getNode } from "@/lib/node/db";
import { getNodeMount, removeNodeMount } from "@/lib/node/mount";
import { canPublishAsset, mountHostSidePermitted } from "@/lib/asset/perm";
import { canShareWiki } from "@/lib/wiki/perm";

type Ctx = { params: Promise<{ id: string; nodeId: string; mountId: string }> };

// DELETE：解除挂载 = 终止一次分享，**任一方**都有权终止（AI review 指正：原实现
// 只查本体侧，宿主管理者摘不掉别人挂到自己 scene/cue 上的东西）：
//   · 本体侧（收回自己的分享）：asset → publication@delete；wiki → canShareWiki
//   · 宿主侧（清理自己的挂载点）：mountHostSidePermitted——能挂就能摘
// 解除即让渡收缩，不留物化残余。

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, nodeId, mountId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const node = await getNode(nodeId, productionId);
  if (!node) return Response.json({ error: "节点不存在" }, { status: 404 });

  const mount = await getNodeMount(mountId);
  // id 关联 + production 归属双校验（PR #424 review 认可的定式）
  if (!mount || mount.nodeId !== node.id || mount.productionId !== productionId)
    return Response.json({ error: "挂载不存在" }, { status: 404 });

  const nodeSideOk = node.kind === "asset"
    ? await canPublishAsset(actor, productionId, node.assetId!, "delete")
    : node.kind === "wiki"
      ? await canShareWiki(actor, productionId, node.wikiId!)
      : false;
  const allowed = nodeSideOk
    || await mountHostSidePermitted(actor, productionId, mount.mountType, mount.mountId);
  if (!allowed) return Response.json({ error: "权限不足" }, { status: 403 });

  await removeNodeMount(mount.id);
  return Response.json({ ok: true });
}
