import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getUserPrimaryEmail } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ name: null });
  const email = await getUserPrimaryEmail(session.userId);
  return Response.json({
    name: session.name,
    avatarUrl: session.avatarUrl,
    isAdmin: session.isAdmin,
    userId: session.userId,
    email,
  });
}
