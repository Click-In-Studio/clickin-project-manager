import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { moveNodeLink, renameNodeLink } from "@/lib/node/link";
import { deleteNode, getNode } from "@/lib/node/db";
import { canPlaceNodeUnder, canWriteNodeContainer } from "@/lib/node/perm";
import { readPlacement, readTrimmedId } from "@/lib/wiki/input";

type Ctx = { params: Promise<{ id: string; aliasId: string }> };

// PATCH  /api/production/[id]/wiki-alias/[aliasId]   移动/重排（位置面）+ 改显示名
// DELETE /api/production/[id]/wiki-alias/[aliasId]   删掉这一个位置
//
// 所有动作都只动**位置**（含这个位置上的标签），目标一个字节不动，所以门里
// **没有** canEditWiki(目标)。三道位置面门与 wiki 移动同源（#358 → #420 node 化）。

async function loadLink(aliasId: string, productionId: string) {
  const n = await getNode(aliasId, productionId);
  return n && n.kind === "link" ? n : null;
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, aliasId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const existing = await loadLink(aliasId, productionId);
  if (!existing) return Response.json({ error: "链接不存在" }, { status: 404 });

  const body = await req.json() as Record<string, unknown>;
  // 显示名（#358 ⑤）：字符串＝改名，null＝改回跟随目标，其余（含缺席）＝本帧不动
  const displayTitle = typeof body.displayTitle === "string" ? body.displayTitle
    : body.displayTitle === null ? null : undefined;
  const changingParent = body.parentId !== undefined;
  const targetParentId = changingParent ? readTrimmedId(body.parentId) : existing.parentId;
  const place = readPlacement(body.place);
  const movingPosition = changingParent || place !== null;

  // 改显示名单独一档门（容器写门 ∨ 创建者，同 DELETE），**不跑位置面那三道**
  if (displayTitle !== undefined) {
    if (!await canWriteNodeContainer(actor, productionId, existing.parentId)
        && existing.createdBy !== session.userId)
      return Response.json({ error: "无权重命名该链接" }, { status: 403 });
    const renamed = await renameNodeLink(aliasId, productionId, displayTitle);
    if (!renamed) return Response.json({ error: "链接不存在" }, { status: 404 });
    if (!movingPosition) return Response.json({ alias: renamed });
  }

  if (!await canPlaceNodeUnder(actor, productionId, targetParentId))
    return Response.json({ error: "无权移动到该父节点下" }, { status: 403 });
  if (!await canWriteNodeContainer(actor, productionId, targetParentId))
    return Response.json({ error: "无权修改该父节点的子目录" }, { status: 403 });
  if (changingParent && targetParentId !== existing.parentId
      && !await canWriteNodeContainer(actor, productionId, existing.parentId))
    return Response.json({ error: "无权把链接移出原父节点" }, { status: 403 });

  const res = await moveNodeLink(aliasId, productionId, {
    ...(changingParent ? { parentId: targetParentId } : {}),
    ...(place ? { place } : {}),
  });
  if (!res.ok) {
    if (res.reason === "not_found") return Response.json({ error: "链接不存在" }, { status: 404 });
    if (res.reason === "duplicate")
      return Response.json({ error: "该位置已有指向同一目标的链接" }, { status: 409 });
    if (res.reason === "inside_target_subtree")
      return Response.json({ error: "不能把链接移进目标自己的子树里" }, { status: 400 });
    return Response.json({ error: "移动失败" }, { status: 400 });
  }
  return Response.json({ alias: res.link });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, aliasId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const existing = await loadLink(aliasId, productionId);
  if (!existing) return Response.json({ error: "链接不存在" }, { status: 404 });

  // 删链接＝把一个子项从容器里拿掉，行使的是对**容器**的权限（链接不是资源）；
  // 建链接的人自己删自己的另开一条（#358 拍板原文见 git 史）。
  if (!await canWriteNodeContainer(actor, productionId, existing.parentId)
      && existing.createdBy !== session.userId)
    return Response.json({ error: "无权删除该链接" }, { status: 403 });

  const res = await deleteNode(aliasId, productionId);
  if (!res.ok) return Response.json({ error: "链接不存在" }, { status: 404 });
  return Response.json({ ok: true });
}
