import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { verifyConflictToken } from "@/lib/platform/email/email-tokens";
import { getAccountSummary, getSharedProductions } from "@/lib/db";

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const token = req.nextUrl.searchParams.get("token");
  if (!token) return Response.json({ error: "missing token" }, { status: 400 });

  const data = verifyConflictToken(token);
  if (!data) return Response.json({ error: "invalid or expired token" }, { status: 400 });

  const { userIdA, userIdB } = data;
  if (session.userId !== userIdA && session.userId !== userIdB) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const [summaryA, summaryB, shared] = await Promise.all([
    getAccountSummary(userIdA),
    getAccountSummary(userIdB),
    getSharedProductions(userIdA, userIdB),
  ]);

  return Response.json({
    userIdA,
    userIdB,
    summaryA,
    summaryB,
    canMerge: shared.length === 0,
    sharedProductions: shared,
  });
}
