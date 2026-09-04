import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getCueListIdForCue } from "@/lib/db";
import { hasGrant, hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { canAccessNode } from "@/lib/grant-template";
import { listWikiRefsForEntity, addManualWikiEntityLink, removeManualWikiEntityLink } from "@/lib/wiki/links";
import { createWiki, deleteWiki } from "@/lib/wiki/content";
import { ensureDramaturgyRootAnchor } from "@/lib/node/anchors";
import { canViewWiki } from "@/lib/wiki/perm";
import { canViewAsset } from "@/lib/asset/perm";
import { getAsset } from "@/lib/asset/db";
import type { PermissionContext } from "@/lib/permissions";

// 对象侧"相关 wiki"面板：引用了该实体的 wiki 列表 + manual 边读写（Phase 2）。
// GET 门 = 宿主对象的可见性（面板长在宿主页上，per-type 沿用各域现有读取门）；
// wiki 侧刻意标题级列出、不过滤 wiki 可见性——名字不敏感、内容敏感（§4.1），
// 点击处由 wiki 页过门+申请。与 backlinks 端点（wiki 页反向面板）同构。
// POST/DELETE（manual 边）门 = 宿主 view ∧ wiki view：边零权限语义（不开任何门），
// 建链不需要比"两头都看得见"更重的资格。新建并链接（createTitle 路径）
// 额外要 wiki/*@create（与 wiki POST 路由同门），文档默认落「戏剧构作」系统根。
// wiki→wiki 不走此端点（已有 /wiki/[wikiId]/backlinks；正文 [[ 即建边）。

const ENTITY_TYPES = new Set(["scene", "rehearsal", "block", "cue", "asset"]);

async function hostViewPermitted(
  permCtx: PermissionContext, productionId: string, entityType: string, entityId: string,
): Promise<boolean> {
  switch (entityType) {
    case "scene":
    case "rehearsal":
    case "block":
      // 剧本域三 kind 同门（mention-resolve 同款：blocks@view）。不校验 entityId
      // 归属本 production（cue/asset 分支的归属校验是过门必需的副产品——门长在
      // 实例上，先找宿主才知道门在哪；剧本域门是 production 级通配，无宿主可找）：
      // 传外剧组 id 也只能查到 *本* production 的边（listWikiRefsForEntity 按
      // production_id 过滤），返回的是本剧组 wiki 的标题级信息，观看者已过本域门
      return permCtx.isAdmin || permCtx.isOwner
        || await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "view");
    case "cue": {
      const cueListId = await getCueListIdForCue(entityId, productionId);
      if (!cueListId) return false;
      const access = await canAccessNode(
        permCtx, productionId, "cue_list", cueListId, "cues", "view");
      return access.allowed;
    }
    case "asset": {
      const asset = await getAsset(entityId);
      if (!asset || asset.productionId !== productionId) return false;
      return canViewAsset(permCtx, productionId, asset, "meta");
    }
    default:
      return false;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const entityType = req.nextUrl.searchParams.get("type") ?? "";
  const entityId = req.nextUrl.searchParams.get("id") ?? "";
  if (!ENTITY_TYPES.has(entityType) || !entityId) {
    return Response.json({ error: "非法的实体类型或 id" }, { status: 400 });
  }

  if (!await hostViewPermitted(access.permCtx, productionId, entityType, entityId)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }

  const refs = await listWikiRefsForEntity(productionId, entityType, entityId);
  return Response.json({ refs });
}

type WriteCtx = {
  productionId: string;
  userId: string;
  actor: ReturnType<typeof toActor>;
  permCtx: PermissionContext;
};

/** POST/DELETE 共用前置：session + 归档 + entityType/entityId + 宿主 view 门。 */
async function guardWrite(
  req: NextRequest, ctx: { params: Promise<{ id: string }> },
  entityType: string, entityId: string,
): Promise<WriteCtx | Response> {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!ENTITY_TYPES.has(entityType) || !entityId) {
    return Response.json({ error: "非法的实体类型或 id" }, { status: 400 });
  }
  if (!await hostViewPermitted(access.permCtx, productionId, entityType, entityId)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  return {
    productionId, userId: session.userId,
    actor: toActor(session, access.permCtx), permCtx: access.permCtx,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => ({})) as {
    entityType?: string; entityId?: string; wikiId?: string; createTitle?: string;
  };
  const guarded = await guardWrite(req, ctx, body.entityType ?? "", body.entityId ?? "");
  if (guarded instanceof Response) return guarded;
  const { productionId, userId, actor } = guarded;

  // 路径一：链接已有文档
  if (body.wikiId) {
    if (!await canViewWiki(actor, productionId, body.wikiId)) {
      return Response.json({ error: "无权访问该文档" }, { status: 403 });
    }
    const ok = await addManualWikiEntityLink({
      wikiId: body.wikiId, productionId,
      entityType: body.entityType!, entityId: body.entityId!, createdBy: userId,
    });
    if (!ok) return Response.json({ error: "文档不存在" }, { status: 404 });
    return Response.json({ ok: true }, { status: 201 });
  }

  // 路径二：新建并链接（dramaturgy「啪建啪跳」流），默认落「戏剧构作」根
  const title = body.createTitle?.trim();
  if (!title) return Response.json({ error: "缺少 wikiId 或 createTitle" }, { status: 400 });
  if (!await hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create")) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }
  const rootId = await ensureDramaturgyRootAnchor(productionId);
  const wiki = await createWiki({
    productionId, title, parentNodeId: rootId, createdBy: userId,
  });
  // 建档与建边不在同一事务（createWiki 本身是多语句+广播副作用，不接受外部
  // client）——以补偿删除保证"啪建啪跳"流的原子观感：边落不下就不留孤儿文档
  try {
    await addManualWikiEntityLink({
      wikiId: wiki.id, productionId,
      entityType: body.entityType!, entityId: body.entityId!, createdBy: userId,
    });
  } catch (e) {
    await deleteWiki(wiki.id, productionId).catch(() => {});
    throw e;
  }
  return Response.json({ wiki }, { status: 201 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const entityType = req.nextUrl.searchParams.get("type") ?? "";
  const entityId = req.nextUrl.searchParams.get("id") ?? "";
  const wikiId = req.nextUrl.searchParams.get("wikiId") ?? "";
  if (!wikiId) return Response.json({ error: "缺少 wikiId" }, { status: 400 });
  const guarded = await guardWrite(req, ctx, entityType, entityId);
  if (guarded instanceof Response) return guarded;

  // 只删 manual 行；body 边归正文管理。不验 wiki 可见性——解除引用不泄露内容，
  // 且宿主侧维护者应能移除任何人挂上来的链接（与挂载移除同姿态）
  await removeManualWikiEntityLink(wikiId, guarded.productionId, entityType, entityId);
  return Response.json({ ok: true });
}
