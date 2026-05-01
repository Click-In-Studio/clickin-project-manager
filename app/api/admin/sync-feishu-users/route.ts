import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { upsertContactUser } from "@/lib/db";
import { fetchAllTenantUsersRaw } from "@/lib/feishu-auth";

export async function POST(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const users = await fetchAllTenantUsersRaw();
  await Promise.all(
    users.map((u) => upsertContactUser(u.openId, u.name, u.avatarUrl, u.email, u.phone))
  );
  return Response.json({ ok: true, total: users.length });
}
