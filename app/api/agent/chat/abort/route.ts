import { type NextRequest, NextResponse } from "next/server";
import { abortChatRun } from "@/lib/agent-gateway/client";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";

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
    const aborted = await abortChatRun(sessionKey);
    return NextResponse.json({ aborted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
