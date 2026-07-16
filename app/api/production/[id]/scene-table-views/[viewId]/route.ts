import { type NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { hasPermission } from "@/lib/roles";
import { getCtx } from "../ctx";

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/scene-table-views/[viewId]">
) {
  const { id, viewId } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }

  const body = await req.json();
  const pool = getPool();

  const existing = await pool.query<{ open_id: string }>(
    `SELECT open_id FROM scene_table_view_config WHERE id = $1 AND production_id = $2`,
    [viewId, id]
  );
  if (existing.rowCount === 0) {
    return Response.json({ error: "视图不存在" }, { status: 404 });
  }
  if (existing.rows[0].open_id !== session.openId) {
    return Response.json({ error: "无权修改他人视图" }, { status: 403 });
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (typeof body.name === "string") {
    sets.push(`view_name = $${paramIdx}`);
    values.push(body.name.trim());
    paramIdx++;
  }
  if (body.config && typeof body.config === "object") {
    sets.push(`config = $${paramIdx}`);
    values.push(JSON.stringify(body.config));
    paramIdx++;
  }

  if (sets.length === 0) {
    return Response.json({ error: "没有需要更新的字段" }, { status: 400 });
  }

  sets.push(`updated_at = NOW()`);
  values.push(viewId, id, session.openId);

  const res = await pool.query<{
    id: string;
    view_name: string;
    is_default: boolean;
    config: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `UPDATE scene_table_view_config
     SET ${sets.join(", ")}
     WHERE id = $${paramIdx} AND production_id = $${paramIdx + 1} AND open_id = $${paramIdx + 2}
     RETURNING id, view_name, is_default, config, created_at, updated_at`,
    values
  );

  if (res.rowCount === 0) {
    return Response.json({ error: "更新失败" }, { status: 500 });
  }

  const row = res.rows[0];
  return Response.json({
    id: row.id,
    name: row.view_name,
    isDefault: row.is_default,
    config: row.config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/scene-table-views/[viewId]">
) {
  const { id, viewId } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }

  const pool = getPool();

  const existing = await pool.query<{ open_id: string; is_default: boolean }>(
    `SELECT open_id, is_default FROM scene_table_view_config WHERE id = $1 AND production_id = $2`,
    [viewId, id]
  );
  if (existing.rowCount === 0) {
    return Response.json({ error: "视图不存在" }, { status: 404 });
  }
  if (existing.rows[0].open_id !== session.openId) {
    return Response.json({ error: "无权删除他人视图" }, { status: 403 });
  }

  await pool.query(
    `DELETE FROM scene_table_view_config WHERE id = $1 AND production_id = $2 AND open_id = $3`,
    [viewId, id, session.openId]
  );

  return Response.json({ ok: true });
}
