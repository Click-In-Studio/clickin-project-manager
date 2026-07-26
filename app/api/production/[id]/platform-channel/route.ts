import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getPool } from "@/lib/pg";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

// GET /api/production/:id/platform-channel         — get current production-level channel (org_id IS NULL)
// PUT /api/production/:id/platform-channel         — upsert production-level channel (制作人 only)
// DELETE /api/production/:id/platform-channel?channelId= — remove channel (制作人 only)

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/platform-channel">) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;

  const row = await getPool().query<{
    id: string; platform_id: string; platform_channel_id: string; created_at: string;
  }>(
    `SELECT id, platform_id, platform_channel_id, created_at
     FROM production_platform_channel
     WHERE production_id = $1 AND org_id IS NULL`,
    [id],
  );
  return Response.json(row.rows[0] ?? null);
}

export async function PUT(req: NextRequest, ctx: RouteContext<"/api/production/[id]/platform-channel">) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, id);
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权配置通知通道" }, { status: 403 });
  }

  const body = await req.json() as { platform_id?: string; platform_channel_id?: string };
  const { platform_id, platform_channel_id } = body;
  if (!platform_id || !platform_channel_id) {
    return Response.json({ error: "platform_id 和 platform_channel_id 不能为空" }, { status: 400 });
  }

  const res = await getPool().query<{ id: string }>(
    `INSERT INTO production_platform_channel (production_id, org_id, platform_id, platform_channel_id)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (production_id, COALESCE(org_id, ''))
     DO UPDATE SET platform_id = EXCLUDED.platform_id,
                   platform_channel_id = EXCLUDED.platform_channel_id
     RETURNING id`,
    [id, platform_id, platform_channel_id],
  );
  return Response.json({ id: res.rows[0].id });
}

export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/production/[id]/platform-channel">) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, id);
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权配置通知通道" }, { status: 403 });
  }

  await getPool().query(
    `DELETE FROM production_platform_channel WHERE production_id = $1 AND org_id IS NULL`,
    [id],
  );
  return Response.json({ ok: true });
}
