import { type NextRequest, NextResponse } from "next/server";
import { createNewSessionKey, listChatSessions, getStatus } from "@/lib/agent-gateway/client";
import { requireUser, toErrorResponse } from "@/lib/agent-gateway/http";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  try {
    // listChatSessions self-connects (lazy singleton), so getStatus() right
    // after reflects the actual connection outcome — including the
    // unconfigured/pairing_required states the UI banner needs.
    const sessions = await listChatSessions(auth.userId);
    return NextResponse.json({ sessions, gatewayStatus: getStatus() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// Doesn't touch the Gateway — a session only springs into existence there on
// its first actual message. This just hands back a fresh per-user key.
export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ key: createNewSessionKey(auth.userId) }, { status: 201 });
}
