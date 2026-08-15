import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { getPool } from "@/lib/pg";
import { getWiki, setWikiPublic, setWikiDeptShares, listWikiDeptShares } from "@/lib/wiki-db";
import { canShareWiki } from "@/lib/wiki-perm";
import { WIKI_LEVEL_ROW_SETS, type WikiLevel } from "@/lib/resource-grant-db";

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

  const people = await getPool().query<{ user_id: string; subs: string[] }>(
    `SELECT user_id::text AS user_id, array_agg(resource_sub || '@' || permission_level) AS subs
     FROM production_member_grant
     WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2
       AND NOT is_revoked AND (expires_at IS NULL OR expires_at > NOW())
     GROUP BY user_id`,
    [productionId, wikiId],
  );
  const levelOf = (subs: string[]): WikiLevel =>
    subs.includes("grants@edit") ? "manage" : subs.includes("*@edit") ? "edit" : "view";
  return Response.json({
    isPublic: wiki.isPublic,
    deptIds: await listWikiDeptShares(wikiId),
    people: people.rows.map(p => ({ userId: p.user_id, level: levelOf(p.subs) })),
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
    const rows = WIKI_LEVEL_ROW_SETS[level];
    if (!rows) return Response.json({ error: "无效的分享级别" }, { status: 400 });
    const member = await getPool().query(
      `SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2::uuid`,
      [productionId, userId],
    );
    if (!member.rows[0]) return Response.json({ error: "对方不是本项目成员" }, { status: 400 });
    for (const [sub, verb] of rows) {
      await getPool().query(
        `INSERT INTO production_member_grant
           (production_id, user_id, resource_type, resource_id, resource_sub,
            permission_level, grant_source, confirmed_by)
         VALUES ($1, $2::uuid, 'wiki', $3, $4, $5, 'direct', $6::uuid)
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
           WHERE is_revoked = false
         DO NOTHING`,
        [productionId, userId, wikiId, sub, verb, session.userId],
      );
    }
  }

  if (body.removePersonUserId) {
    await getPool().query(
      `UPDATE production_member_grant
       SET is_revoked = true, revoked_reason = 'manual'
       WHERE production_id = $1 AND user_id = $2::uuid
         AND resource_type = 'wiki' AND resource_id = $3 AND NOT is_revoked`,
      [productionId, body.removePersonUserId, wikiId],
    );
  }

  return Response.json({ ok: true });
}
