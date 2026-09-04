import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { getWikiAlias, moveWikiAlias, renameWikiAlias, deleteWikiAlias } from "@/lib/wiki/alias";
import { canPlaceWikiUnder, canWriteWikiContainer } from "@/lib/wiki/enum-perm";
import { readPlacement, readTrimmedId } from "@/lib/wiki/input";

type Ctx = { params: Promise<{ id: string; aliasId: string }> };

// PATCH  /api/production/[id]/wiki-alias/[aliasId]   移动/重排（位置面）+ 改显示名
// DELETE /api/production/[id]/wiki-alias/[aliasId]   删掉这一个位置
//
// 所有动作都只动**位置**（含这个位置上的标签），目标一个字节不动，所以门里
// **没有** canEditWiki(目标)：移动或重命名一个别名不是编辑那篇文档。
//   · 移动/重排：目标父可枚举 ∧ 目标父容器可写 ∧（换父时）源父容器可写
//     ——与 wiki 移动的位置面三道同源。
//   · 改显示名/删除：容器写门 ∨ 别名创建者（见 DELETE 处注释）。

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, aliasId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const existing = await getWikiAlias(aliasId, productionId);
  if (!existing) return Response.json({ error: "链接不存在" }, { status: 404 });

  const body = await req.json() as Record<string, unknown>;
  // 显示名（#358 ⑤）：字符串＝改名，null＝改回跟随目标，其余（含缺席）＝本帧不动
  const displayTitle = typeof body.displayTitle === "string" ? body.displayTitle
    : body.displayTitle === null ? null : undefined;
  const changingParent = body.parentId !== undefined;
  const targetParentId = changingParent ? readTrimmedId(body.parentId) : existing.parentId;
  const place = readPlacement(body.place);
  const movingPosition = changingParent || place !== null;

  // 改显示名单独一档门（容器写门 ∨ 创建者，同 DELETE），**不跑位置面那三道**：
  // 重命名不改变这个别名的位置，让它去过"能不能移到这里"的门是张冠李戴——建别名
  // 的人在别人的容器里放了一个位置，仍应能给自己那个位置改标签。
  if (displayTitle !== undefined) {
    if (!await canWriteWikiContainer(actor, productionId, existing.parentId)
        && existing.createdBy !== session.userId)
      return Response.json({ error: "无权重命名该链接" }, { status: 403 });
    const renamed = await renameWikiAlias(aliasId, productionId, displayTitle);
    if (!renamed) return Response.json({ error: "链接不存在" }, { status: 404 });
    if (!movingPosition) return Response.json({ alias: renamed });
  }

  if (!await canPlaceWikiUnder(actor, productionId, targetParentId))
    return Response.json({ error: "无权移动到该父文档下" }, { status: 403 });
  if (!await canWriteWikiContainer(actor, productionId, targetParentId))
    return Response.json({ error: "无权修改该父文档的子目录" }, { status: 403 });
  if (changingParent && targetParentId !== existing.parentId
      && !await canWriteWikiContainer(actor, productionId, existing.parentId))
    return Response.json({ error: "无权把链接移出原父文档" }, { status: 403 });

  const res = await moveWikiAlias(aliasId, productionId, {
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
  return Response.json({ alias: res.alias });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, aliasId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const existing = await getWikiAlias(aliasId, productionId);
  if (!existing) return Response.json({ error: "链接不存在" }, { status: 404 });

  // 删别名＝把一个子项从容器里拿掉，行使的是对**容器**的权限（别名没有自己的
  // delete 权可发——它不是资源）。顶层容器写门恒真是 #357 拍下的根容器本体论
  // （"根容器上不存在 edit 权，没有实体可以持有它"），别名跟着这条走；建别名的
  // 人自己删自己的另开一条，免得顶层之外的位置被容器主锁死。
  if (!await canWriteWikiContainer(actor, productionId, existing.parentId)
      && existing.createdBy !== session.userId)
    return Response.json({ error: "无权删除该链接" }, { status: 403 });

  const ok = await deleteWikiAlias(aliasId, productionId);
  if (!ok) return Response.json({ error: "链接不存在" }, { status: 404 });
  return Response.json({ ok: true });
}
