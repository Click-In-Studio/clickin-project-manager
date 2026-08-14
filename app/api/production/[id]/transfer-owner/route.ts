import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getPool } from "@/lib/pg";

// Owner 转让：ROOT OPERATION——仅现任 owner 或平台 admin。
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!(session.isAdmin || access.permCtx.isOwner)) {
    return Response.json({ error: "仅项目所有者可转让" }, { status: 403 });
  }

  const { newOwnerId } = (await req.json()) as { newOwnerId?: string };
  if (!newOwnerId) return Response.json({ error: "缺少 newOwnerId" }, { status: 400 });

  const member = await getPool().query(
    "SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2",
    [id, newOwnerId],
  );
  if (member.rows.length === 0) {
    return Response.json({ error: "新 Owner 必须是项目成员" }, { status: 400 });
  }

  await getPool().query(
    "UPDATE production SET owner_id = $2 WHERE id = $1",
    [id, newOwnerId],
  );
  return Response.json({ ok: true });
}
