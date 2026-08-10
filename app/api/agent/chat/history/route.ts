import { type NextRequest, NextResponse } from "next/server";
import { getChatHistory } from "@/lib/agent-gateway/client";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";

export const runtime = "nodejs";

// Gateway is the sole owner of chat state (no local persistence) — this just
// projects it so a reload doesn't lose the visible conversation.
export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  const sessionKey = req.nextUrl.searchParams.get("sessionKey");
  if (!sessionKey) return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  try {
    const messages = await getChatHistory(sessionKey);
    return NextResponse.json({ messages });
  } catch (err) {
    return toErrorResponse(err);
  }
}
