import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getUserProfile, upsertUserProfile } from "@/lib/db";

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

  await upsertUserProfile(session.userId, name, body.avatarUrl ?? null, {
    displayName: body.displayName,
    bio: body.bio,
    preferredPlatform: body.preferredPlatform,
  });
  return Response.json({ ok: true });
}
