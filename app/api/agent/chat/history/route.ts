import { type NextRequest, NextResponse } from "next/server";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent/chat/http";
import { getHistoryPage } from "@/lib/agent/runtime/chat-history-db";

export const runtime = "nodejs";

// 会话历史投影（reload 不丢可见对话）：从 agent_session_entry 投影成 ChatTranscriptEntry[]。
export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  const sessionKey = req.nextUrl.searchParams.get("sessionKey");
  if (!sessionKey) return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  try {
    return NextResponse.json(await getHistoryPage(sessionKey, req.nextUrl.searchParams.get("cursor")));
  } catch (err) {
    return toErrorResponse(err);
  }
}
