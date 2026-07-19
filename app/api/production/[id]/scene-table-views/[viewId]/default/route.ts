import { type NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { hasPermission } from "@/lib/roles";
import { getCtx } from "../../ctx";

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/scene-table-views/[viewId]/default">
) {
  const { id, viewId } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ user_id: string }>(
      `SELECT user_id FROM scene_table_view_config WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [viewId, id]
    );
    if (existing.rowCount === 0) {
      await client.query("ROLLBACK");
      return Response.json({ error: "视图不存在" }, { status: 404 });
    }
    if (existing.rows[0].user_id !== session.userId) {
      await client.query("ROLLBACK");
      return Response.json({ error: "无权修改他人视图" }, { status: 403 });
    }

    await client.query(
      `UPDATE scene_table_view_config
       SET is_default = false, updated_at = NOW()
       WHERE user_id = $1 AND production_id = $2`,
      [session.userId, id]
    );
    await client.query(
      `UPDATE scene_table_view_config
       SET is_default = true, updated_at = NOW()
       WHERE id = $3 AND user_id = $1 AND production_id = $2`,
      [session.userId, id, viewId]
    );
    await client.query("COMMIT");

    return Response.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
