import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { listWikiLibrary, createWiki, searchWiki, ensureDramaturgyRootAnchor } from "@/lib/wiki-db";
import { listVisibleWikiIds } from "@/lib/wiki-perm";

type Ctx = { params: Promise<{ id: string }> };

// GET  /api/production/[id]/wiki[?q=]   文档库列表（树平铺，可见性过滤）/ 搜索
// POST /api/production/[id]/wiki        创建文档（门：node:wiki/*@create）

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const visible = await listVisibleWikiIds(actor, productionId);
  const q = req.nextUrl.searchParams.get("q");
  if (q) {
    const hits = await searchWiki(productionId, q);
    return Response.json({
      results: visible.wildcard ? hits : hits.filter(h => visible.ids.has(h.id)),
    });
  }
  const all = await listWikiLibrary(productionId);
  const wikis = visible.wildcard ? all : all.filter(w => visible.ids.has(w.id));
  return Response.json({ wikis });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  if (!await hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as {
    title?: string; body?: string; parentId?: string | null;
    /** 显式 parentId 缺席时的落位锚点。锚点可能尚未建（懒建），由服务端在**过完
     *  create 门之后**补建——ensure 是写事务，渲染路径一律不准碰。 */
    parentAnchor?: "dramaturgy";
  };
  if (!body.title?.trim()) return Response.json({ error: "标题不能为空" }, { status: 400 });

  const parentId = body.parentId?.trim()
    || (body.parentAnchor === "dramaturgy" ? await ensureDramaturgyRootAnchor(productionId) : null);

  try {
    const wiki = await createWiki({
      productionId,
      title: body.title.trim(),
      body: body.body ?? "",
      parentId,
      createdBy: session.userId,
    });
    return Response.json({ wiki }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "创建失败" }, { status: 400 });
  }
}
