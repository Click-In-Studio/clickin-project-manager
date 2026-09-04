import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getUserProfile, upsertUserProfile, syncGlobalNotificationPreference } from "@/lib/db";
import { deleteAvatarObjects } from "@/lib/avatar-serve";

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

  await upsertUserProfile(session.userId, name, body.avatarUrl ?? null, {
    displayName: body.displayName,
    bio: body.bio,
    preferredPlatform: body.preferredPlatform,
  });

  // 头像 key 每次上传换新（presign 路由）；换掉后清旧对象，尽力而为
  if (oldAvatar && oldAvatar !== (body.avatarUrl ?? null)) {
    void deleteAvatarObjects(oldAvatar);
  }

  // Sync global notification_preference when preferred platform changes
  if (body.preferredPlatform !== undefined) {
    await syncGlobalNotificationPreference(session.userId, body.preferredPlatform ?? null);
  }

  return Response.json({ ok: true });
}
