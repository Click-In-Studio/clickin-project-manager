import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { upsertContactUser } from "@/lib/db";
import { feishuPlatform } from "@/lib/platform/feishu";

export async function POST(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const promises: Promise<unknown>[] = [];
  for await (const u of feishuPlatform.importAllUsers()) {
    promises.push(upsertContactUser(u.platformUserId, u.name, u.avatarUrl ?? null, u.email ?? null, u.mobile ?? null));
  }
  await Promise.all(promises);
  return Response.json({ ok: true, total: promises.length });
}
