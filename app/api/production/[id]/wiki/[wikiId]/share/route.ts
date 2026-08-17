import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import {
  getWiki, setWikiPublic, setWikiDeptShares, listWikiDeptShares,
  listWikiSharePeople, addWikiSharePerson, removeWikiSharePerson,
} from "@/lib/wiki-db";
import { canShareWiki } from "@/lib/wiki-perm";
import { type WikiLevel } from "@/lib/resource-grant-db";

type Ctx = { params: Promise<{ id: string; wikiId: string }> };

// 分享面（门=grants@edit 保留段）：个人=grant 行集；部门=wiki_dept_share 结构面；
// 全体=is_public 列。结构面永不物化行（§0.9 负面清单）。

type Guarded =
  | { err: Response }
  | {
      err?: undefined;
      productionId: string;
      wikiId: string;
      session: NonNullable<ReturnType<typeof getSession>>;
      wiki: NonNullable<Awaited<ReturnType<typeof getWiki>>>;
      isArchived: boolean;
    };

async function guard(req: NextRequest, ctx: Ctx): Promise<Guarded> {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return { err: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { err: Response.json({ error: "无权访问" }, { status: 403 }) };
  const actor = toActor(session, access.permCtx);
  const wiki = await getWiki(wikiId, productionId);
  if (!wiki) return { err: Response.json({ error: "文档不存在" }, { status: 404 }) };
  if (!await canShareWiki(actor, productionId, wikiId))
    return { err: Response.json({ error: "权限不足（分享面）" }, { status: 403 }) };
  return { productionId, wikiId, session, wiki, isArchived: access.isArchived };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const g = await guard(req, ctx);
  if (g.err !== undefined) return g.err;
  const { productionId, wikiId, wiki } = g;

  return Response.json({
    isPublic: wiki.isPublic,
    deptIds: await listWikiDeptShares(wikiId),
    people: await listWikiSharePeople(wikiId, productionId),
  });
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
  const g = await guard(req, ctx);
  if (g.err !== undefined) return g.err;
  if (g.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { productionId, wikiId, session } = g;

  const body = await req.json() as {
    isPublic?: boolean;
    deptIds?: string[];
    addPerson?: { userId: string; level: WikiLevel };
    removePersonUserId?: string;
  };

  if (body.isPublic !== undefined) await setWikiPublic(wikiId, productionId, body.isPublic);
  if (body.deptIds !== undefined) await setWikiDeptShares(wikiId, productionId, body.deptIds);

  if (body.addPerson) {
    const { userId, level } = body.addPerson;
    const r = await addWikiSharePerson(wikiId, productionId, { userId, level, confirmedBy: session.userId });
    if (r === "invalid_level") return Response.json({ error: "无效的分享级别" }, { status: 400 });
    if (r === "not_member") return Response.json({ error: "对方不是本项目成员" }, { status: 400 });
  }

  if (body.removePersonUserId) {
    await removeWikiSharePerson(wikiId, productionId, body.removePersonUserId);
  }

  return Response.json({ ok: true });
}
