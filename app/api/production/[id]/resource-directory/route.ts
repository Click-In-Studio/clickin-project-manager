import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasAdminPanelEligibility } from "@/lib/permissions";
import { getPool } from "@/lib/pg";
import { toActor } from "@/lib/grant-check";
import { listEnumerableWikiIds } from "@/lib/wiki-perm";
import { RESOURCE_DIRECTORY_QUERIES } from "@/lib/resource-directory";

// GET ?type=<resource_type> — 该类型的资源实例清单 {id,label}，供权限键
// 选择器的 id 位下拉。只回 id+名称（无内容字段）；门=管理面资格。
// 未支持的类型返回空数组（picker 落回自由输入）。
// 查询表在 lib/resource-directory.ts——权限中心的实例行折叠（#274）同源使用。

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(session.isAdmin || permCtx.isAdmin || permCtx.isOwner || hasAdminPanelEligibility(permCtx.memberPermissions))) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const type = req.nextUrl.searchParams.get("type") ?? "";

  // wiki 特例（W3）：标题沿可见性流出——按调用者过滤，不能像其他类型全量列出
  // （管理面资格 ≠ 单篇文档可见性）。这里是**列举**动作，门＝枚举面（#357）：
  // 授权选择器里能列到什么，与目录树里能列到什么必须是同一个集合。
  if (type === "wiki") {
    const visible = await listEnumerableWikiIds(toActor(session, permCtx), id);
    const { rows } = await getPool().query<{ id: string; label: string }>(
      `SELECT id::text AS id, COALESCE(title, id::text) AS label
       FROM wiki WHERE production_id = $1 AND title IS NOT NULL ORDER BY created_at DESC`,
      [id],
    );
    const items = visible.wildcard ? rows : rows.filter(r => visible.ids.has(r.id));
    return Response.json({ items: items.slice(0, 500) });
  }

  const sql = RESOURCE_DIRECTORY_QUERIES[type];
  if (!sql) return Response.json({ items: [] });

  const { rows } = await getPool().query<{ id: string; label: string }>(sql, [id]);
  return Response.json({ items: rows.slice(0, 500) });
}
