import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasAdminPanelEligibility } from "@/lib/permissions";
import { getPool } from "@/lib/pg";
import { toActor } from "@/lib/grant-check";
import { listEnumerableWikiIds, listVisibleWikiIds } from "@/lib/wiki-perm";
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
  // （管理面资格 ≠ 单篇文档可见性）。
  //
  // 门＝**可达集 ∪ 可枚举闭包**（#357），与 `[[` 补全的候选集上界同一个集合。
  // 两个面都要，缺任何一个都出问题：
  //   - 只取枚举面 → is_public ∧ !listable 的文档（可读、靠链接传播）在选择器里
  //     消失，非 admin 的管理面资格者反而没法给它发权限（AI review #2 的 bootstrap
  //     缺口；admin/owner 走 wildcard 不受影响，所以这缺口只咬管理面资格者）
  //   - 只取内容面 → 就是本 PR 之前的状态，目录里列得到的却选不到
  // 两者都是调用者**已经知道**的文档（能读 ∨ 能在树里列到），并集不构成新披露，
  // 也不是枚举面后门——闭包外的只有他自己读得了的那些。
  if (type === "wiki") {
    const actor = toActor(session, permCtx);
    const [enumerable, visible] = await Promise.all([
      listEnumerableWikiIds(actor, id),
      listVisibleWikiIds(actor, id),
    ]);
    const { rows } = await getPool().query<{ id: string; label: string }>(
      `SELECT id::text AS id, COALESCE(title, id::text) AS label
       FROM wiki WHERE production_id = $1 AND title IS NOT NULL ORDER BY created_at DESC`,
      [id],
    );
    const items = (enumerable.wildcard || visible.wildcard)
      ? rows
      : rows.filter(r => enumerable.ids.has(r.id) || visible.ids.has(r.id));
    return Response.json({ items: items.slice(0, 500) });
  }

  const sql = RESOURCE_DIRECTORY_QUERIES[type];
  if (!sql) return Response.json({ items: [] });

  const { rows } = await getPool().query<{ id: string; label: string }>(sql, [id]);
  return Response.json({ items: rows.slice(0, 500) });
}
