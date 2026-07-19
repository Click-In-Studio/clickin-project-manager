import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { hasPermission } from "@/lib/roles";
import { getCtx } from "./ctx";

type ViewConfig = {
  columnOrder: string[];
  visibleColumns: string[];
  columnWidths: Record<string, number>;
};

type ViewRow = {
  id: string;
  user_id: string;
  production_id: string;
  view_name: string;
  is_default: boolean;
  config: ViewConfig;
  created_at: string;
  updated_at: string;
};

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scene-table-views">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }

  const pool = getPool();
  const res = await pool.query<ViewRow>(
    `SELECT id, user_id, production_id, view_name, is_default, config, created_at, updated_at
     FROM scene_table_view_config
     WHERE user_id = $1 AND production_id = $2
     ORDER BY is_default DESC, created_at ASC`,
    [session.userId, id]
  );

  const views = res.rows.map((row) => ({
    id: row.id,
    name: row.view_name,
    isDefault: row.is_default,
    config: row.config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return Response.json({ views });
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scene-table-views">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }

  const body = await req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const config = body.config && typeof body.config === "object" ? body.config : {};
  const isDefault = body.isDefault === true;

  if (!name) {
    return Response.json({ error: "视图名称不能为空" }, { status: 400 });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (isDefault) {
      await client.query(
        `UPDATE scene_table_view_config
         SET is_default = false, updated_at = NOW()
         WHERE user_id = $1 AND production_id = $2`,
        [session.userId, id]
      );
    }

    const newId = randomUUID();
    const res = await client.query<ViewRow>(
      `INSERT INTO scene_table_view_config
         (id, user_id, production_id, view_name, is_default, config)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, production_id, view_name, is_default, config, created_at, updated_at`,
      [newId, session.userId, id, name, isDefault, JSON.stringify(config)]
    );

    await client.query("COMMIT");

    const row = res.rows[0];
    return Response.json({
      id: row.id,
      name: row.view_name,
      isDefault: row.is_default,
      config: row.config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }, { status: 201 });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
