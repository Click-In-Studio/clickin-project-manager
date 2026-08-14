import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasAdminPanelEligibility } from "@/lib/permissions";
import { getPool } from "@/lib/pg";

// GET ?type=<resource_type> — 该类型的资源实例清单 {id,label}，供权限键
// 选择器的 id 位下拉。只回 id+名称（无内容字段）；门=管理面资格。
// 未支持的类型返回空数组（picker 落回自由输入）。

const QUERIES: Record<string, string> = {
  cue_list: "SELECT id, COALESCE(name, id) AS label FROM cue_list WHERE production_id = $1 ORDER BY created_at",
  event: "SELECT id, COALESCE(title, id) AS label FROM production_event WHERE production_id = $1 ORDER BY created_at DESC",
  asset: "SELECT id, COALESCE(name, file_name) AS label FROM asset WHERE production_id = $1 ORDER BY created_at DESC",
  milestone: "SELECT id, COALESCE(name, id) AS label FROM milestone WHERE production_id = $1 ORDER BY end_date",
  announcement: "SELECT id, COALESCE(title, id) AS label FROM production_announcement WHERE production_id = $1 ORDER BY created_at DESC",
  org_dept: "SELECT id::text AS id, name AS label FROM production_dept WHERE production_id = $1 ORDER BY display_order, name",
  role: "SELECT id, name AS label FROM production_role WHERE production_id = $1 AND NOT is_deprecated ORDER BY name",
  member: `SELECT pm.user_id::text AS id, COALESCE(up.name, pm.user_id::text) AS label
           FROM production_member pm LEFT JOIN user_profile up ON up.user_id = pm.user_id
           WHERE pm.production_id = $1 ORDER BY up.name NULLS LAST`,
  scene: `SELECT s.id, COALESCE(sv.name, s.id) AS label
          FROM scene s
          LEFT JOIN scene_version sv ON sv.scene_id = s.id
            AND sv.version_id = (SELECT active_version_id FROM production WHERE id = $1)
          WHERE s.production_id = $1 ORDER BY sv.name NULLS LAST`,
  character: `SELECT c.id, COALESCE(cv.name, c.id) AS label
              FROM character c
              LEFT JOIN character_version cv ON cv.character_id = c.id
                AND cv.version_id = (SELECT active_version_id FROM production WHERE id = $1)
              WHERE c.production_id = $1 ORDER BY cv.name NULLS LAST`,
  task: `SELECT etr.id, COALESCE(etr.title, etr.id) AS label
         FROM event_tech_req etr JOIN production_event pe ON pe.id = etr.event_id
         WHERE pe.production_id = $1 ORDER BY etr.id DESC`,
};

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
  const sql = QUERIES[type];
  if (!sql) return Response.json({ items: [] });

  const { rows } = await getPool().query<{ id: string; label: string }>(sql, [id]);
  return Response.json({ items: rows.slice(0, 500) });
}
