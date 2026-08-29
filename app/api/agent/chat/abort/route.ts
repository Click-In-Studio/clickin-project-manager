import { type NextRequest, NextResponse } from "next/server";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-chat/http";
import { abortRun } from "@/lib/agent-runtime/client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  let body: { sessionKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionKey } = body;
  if (!sessionKey || typeof sessionKey !== "string") {
    return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  }
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  try {
    const aborted = await abortRun(sessionKey);
    return NextResponse.json({ aborted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
