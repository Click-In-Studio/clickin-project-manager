import { type NextRequest, NextResponse } from "next/server";
import { getChatHistory } from "@/lib/agent-gateway/client";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";
import { shouldUseRunner } from "@/lib/agent-runtime/dispatch";
import { getHistory } from "@/lib/agent-runtime/client";

export const runtime = "nodejs";

// 会话历史投影（reload 不丢可见对话）。网关会话由网关持有状态；自建运行时会话
// 从 agent_session_entry 投影——两者输出同一形态（ChatTranscriptEntry[]）。
export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  const sessionKey = req.nextUrl.searchParams.get("sessionKey");
  if (!sessionKey) return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  try {
    const messages = (await shouldUseRunner(sessionKey)) ? await getHistory(sessionKey) : await getChatHistory(sessionKey);
    return NextResponse.json({ messages });
  } catch (err) {
    return toErrorResponse(err);
  }
}
