import { type NextRequest, NextResponse } from "next/server";
import { startChatRun, steerChatRun } from "@/lib/agent-gateway/client";
import { createChatStreamResponse } from "@/lib/agent-gateway/relay";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";

export const runtime = "nodejs";

// Sends a new message and streams the reply — newline-delimited JSON via
// plain fetch + ReadableStream rather than EventSource, since EventSource
// can't send a POST body. Each line is one
// { type: "delta" | "final" | "tool" | "tool-end" | "aborted" | "error", ... } event.
export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  let body: { message?: unknown; sessionKey?: unknown; steer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { message, sessionKey, steer } = body;
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "缺少 message" }, { status: 400 });
  }
  if (message.length > 16_000) {
    return NextResponse.json({ error: "消息过长（上限 16000 字符）" }, { status: 400 });
  }
  if (!sessionKey || typeof sessionKey !== "string") {
    return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  }
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  // steer: the session already has a run in flight and this message should
  // be injected into it (queue-aware on 2026.7.x). The reply rides the
  // ALREADY-OPEN stream connection (steerChatRun marks one extra final for
  // it to wait on) — so this returns plain JSON, NOT a second stream.
  // Returning a stream here that no client reads leaked one zombie
  // connection per steer until the browser's per-host pool starved and the
  // whole page went silent (live-debugged in production).
  if (steer === true) {
    try {
      const started = await steerChatRun(sessionKey, message);
      return NextResponse.json({ ok: true, runId: started.runId });
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  return createChatStreamResponse(req, sessionKey, {
    startRun: () => startChatRun(sessionKey, message),
  });
}

// Watch-only: attaches to a session's already-in-flight run instead of
// starting a new one — for reopening a conversation that's mid-reply so it
// keeps streaming live. Callers should only hit this when the session's
// status is "running".
export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  const sessionKey = req.nextUrl.searchParams.get("sessionKey");
  if (!sessionKey) {
    return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  }
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  // Shorter cap than a fresh send: if nothing arrives quickly, the run most
  // likely already finished before this attach landed — fail fast to
  // chat.history instead of sitting idle for 180s.
  return createChatStreamResponse(req, sessionKey, { overallTimeoutMs: 20_000 });
}
