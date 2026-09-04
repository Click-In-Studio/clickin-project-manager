import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getUserProfile, upsertUserProfile, syncGlobalNotificationPreference } from "@/lib/db";
import { markAvatarCommitted, cleanupAvatarObjects } from "@/lib/avatar-db";

export async function GET() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const profile = await getUserProfile(session.userId);
  return Response.json(profile ?? { name: session.name, displayName: null, bio: null, preferredPlatform: null, avatarUrl: session.avatarUrl, isAdmin: session.isAdmin });
}

export async function PATCH(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as {
    name?: string;
    displayName?: string | null;
    bio?: string | null;
    preferredPlatform?: string | null;
    avatarUrl?: string | null;
  };
  const name = body.name?.trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const oldAvatar = (await getUserProfile(session.userId))?.avatarUrl ?? null;

  // PATCH 语义：avatarUrl 字段缺省 = 不动头像（沿用旧值），显式 null 才是清除。
  // 头像 GET 路由以 DB 值为准，这里把缺省坍缩成 null 会直接杀掉在用头像。
  const nextAvatar = "avatarUrl" in body ? body.avatarUrl ?? null : oldAvatar;

  await upsertUserProfile(session.userId, name, nextAvatar, {
    displayName: body.displayName,
    bio: body.bio,
    preferredPlatform: body.preferredPlatform,
  });

  // 头像 key 每次上传换新（presign 路由）；提交平账 + 换掉后清旧对象。
  // 清理尽力而为，且读旧值→写新值非事务：并发换头像可能误删刚上任的对象，
  // 后果只是头像回落外链/404，可接受，不为清理引入事务。
  if (oldAvatar !== nextAvatar) {
    await markAvatarCommitted(nextAvatar);
    void cleanupAvatarObjects(oldAvatar);
  }

  // Sync global notification_preference when preferred platform changes
  if (body.preferredPlatform !== undefined) {
    await syncGlobalNotificationPreference(session.userId, body.preferredPlatform ?? null);
  }

  return Response.json({ ok: true });
}
