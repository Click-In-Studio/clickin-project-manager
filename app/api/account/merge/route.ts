import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { verifyMergeToken } from "@/lib/auth-email";
import { mergeAccounts } from "@/lib/db";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { token?: string };
  if (!body.token) return Response.json({ error: "missing token" }, { status: 400 });

  const data = verifyMergeToken(body.token);
  if (!data) return Response.json({ error: "invalid or expired merge token" }, { status: 400 });

  // The keepUserId must match the current session user
  if (data.keepUserId !== session.userId) {
    return Response.json({ error: "token mismatch" }, { status: 403 });
  }

  await mergeAccounts(data.keepUserId, data.deleteUserId);
  return Response.json({ ok: true });
}
