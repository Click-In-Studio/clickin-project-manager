import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { getWiki, updateWiki, deleteWiki } from "@/lib/wiki-db";
import { canViewWiki, canEditWiki, canDeleteWiki, canShareWiki } from "@/lib/wiki-perm";
import type { Mention } from "@/lib/event-db";
import { setWikiPublic } from "@/lib/wiki-db";

type Ctx = { params: Promise<{ id: string; wikiId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const wiki = await getWiki(wikiId, productionId);
  if (!wiki) return Response.json({ error: "文档不存在" }, { status: 404 });
  if (!await canViewWiki(actor, productionId, wikiId)) {
    // §4.1：标题=目录级信息（引用持有者可见），内容 403 附申请锚
    return Response.json({
      error: "无权访问该文档",
      title: wiki.title,
      applyResource: `node:wiki/${wikiId}@view`,
    }, { status: 403 });
  }
  const canEdit = await canEditWiki(actor, productionId, wikiId);
  const canShare = await canShareWiki(actor, productionId, wikiId);
  return Response.json({ wiki, canEdit, canShare });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const existing = await getWiki(wikiId, productionId);
  if (!existing) return Response.json({ error: "文档不存在" }, { status: 404 });

  const body = await req.json() as {
    title?: string; body?: string; mentions?: Mention[];
    parentId?: string | null; sortKey?: string; tags?: string[];
    isPublic?: boolean;
  };

  const wantsContent = body.title !== undefined || body.body !== undefined
    || body.mentions !== undefined || body.parentId !== undefined
    || body.sortKey !== undefined || body.tags !== undefined;
  if (wantsContent && !await canEditWiki(actor, productionId, wikiId))
    return Response.json({ error: "权限不足" }, { status: 403 });
  // 公开开关属分享面（grants@edit 保留段）
  if (body.isPublic !== undefined && !await canShareWiki(actor, productionId, wikiId))
    return Response.json({ error: "权限不足（分享面）" }, { status: 403 });

  if (body.title !== undefined && !body.title.trim())
    return Response.json({ error: "标题不能为空" }, { status: 400 });

  try {
    if (wantsContent) {
      await updateWiki(wikiId, productionId, {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.mentions !== undefined ? { mentions: body.mentions } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.sortKey !== undefined ? { sortKey: body.sortKey } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
      }, session.userId);
    }
    if (body.isPublic !== undefined) await setWikiPublic(wikiId, productionId, body.isPublic);
    return Response.json({ wiki: await getWiki(wikiId, productionId) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "更新失败" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  if (!await canDeleteWiki(actor, productionId, wikiId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const result = await deleteWiki(wikiId, productionId);
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "文档不存在" }, { status: 404 });
    return Response.json(
      { error: "该文档被 report/note 挂载引用，不可直接删除（先解除挂载）" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
