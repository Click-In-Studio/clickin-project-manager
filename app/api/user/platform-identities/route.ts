import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getPool } from "@/lib/pg";

// GET  /api/user/platform-identities          — list current user's identities
// POST /api/user/platform-identities          — add a new identity
// PATCH /api/user/platform-identities?id=...  — update label
// DELETE /api/user/platform-identities?id=... — remove (cannot remove last login method)

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const rows = await getPool().query<{
    id: string; platform_id: string; platform_user_id: string;
    label: string | null; is_login_method: boolean; created_at: string;
  }>(
    `SELECT id, platform_id, platform_user_id, label, is_login_method, created_at
     FROM user_platform_identity
     WHERE user_id = $1
     ORDER BY is_login_method DESC, created_at ASC`,
    [session.userId],
  );
  return Response.json(rows.rows);
}

export async function POST(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = await req.json() as {
    platform_id?: string;
    platform_user_id?: string;
    label?: string;
    is_login_method?: boolean;
  };
  const { platform_id, platform_user_id, label, is_login_method = false } = body;
  if (!platform_id || !platform_user_id) {
    return Response.json({ error: "platform_id 和 platform_user_id 不能为空" }, { status: 400 });
  }

  const pool = getPool();
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, label, is_login_method)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [session.userId, platform_id, platform_user_id, label ?? null, is_login_method],
    );
    return Response.json({ id: res.rows[0].id }, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return Response.json({ error: "该平台账号已绑定" }, { status: 409 });
    }
    throw e;
  }
}

export async function PATCH(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "缺少 id 参数" }, { status: 400 });

  const { label } = await req.json() as { label?: string };

  const res = await getPool().query(
    `UPDATE user_platform_identity SET label = $1
     WHERE id = $2 AND user_id = $3`,
    [label ?? null, id, session.userId],
  );
  if (res.rowCount === 0) return Response.json({ error: "未找到或无权修改" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "缺少 id 参数" }, { status: 400 });

  const pool = getPool();

  // Refuse if this is the only login method remaining
  const check = await pool.query<{ is_login_method: boolean; login_count: string }>(
    `SELECT upi.is_login_method,
            (SELECT COUNT(*) FROM user_platform_identity WHERE user_id = $2 AND is_login_method = true) AS login_count
     FROM user_platform_identity upi
     WHERE upi.id = $1 AND upi.user_id = $2`,
    [id, session.userId],
  );
  const row = check.rows[0];
  if (!row) return Response.json({ error: "未找到" }, { status: 404 });
  if (row.is_login_method && Number(row.login_count) <= 1) {
    return Response.json({ error: "无法删除最后一个登录方式" }, { status: 422 });
  }

  await pool.query(
    `DELETE FROM user_platform_identity WHERE id = $1 AND user_id = $2`,
    [id, session.userId],
  );
  return Response.json({ ok: true });
}
