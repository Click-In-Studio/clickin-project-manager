import { type NextRequest, NextResponse } from "next/server";
import { startChatRun, steerChatRun, productionIdOfSessionKey } from "@/lib/agent-gateway/client";
import { requireProductionFeature } from "@/lib/plan";
import { createChatStreamResponse } from "@/lib/agent-gateway/relay";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";
import { neutralizeInboundMessage } from "@/lib/agent-ui-context";
import { shouldUseRunner, createRunnerStreamResponse, pageKeyOfMessage } from "@/lib/agent-runtime/dispatch";
import { startRun, steerRun } from "@/lib/agent-runtime/client";

export const runtime = "nodejs";

// Sends a new message and streams the reply — newline-delimited JSON via
// plain fetch + ReadableStream rather than EventSource, since EventSource
// can't send a POST body. Each line is one
// { type: "delta" | "final" | "tool" | "tool-end" | "aborted" | "error", ... } event.
//
// 分流（#367）：会话走网关还是自建运行时由 shouldUseRunner 决定；两条路径的
// 请求/响应契约完全一致，前端不感知。
export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  let body: { message?: unknown; sessionKey?: unknown; steer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { message: rawMessage, sessionKey, steer } = body;
  if (!rawMessage || typeof rawMessage !== "string") {
    return NextResponse.json({ error: "缺少 message" }, { status: 400 });
  }
  if (rawMessage.length > 16_000) {
    return NextResponse.json({ error: "消息过长（上限 16000 字符）" }, { status: 400 });
  }
  // 服务端净化注入分隔符（真边界，客户端 buildUiContextMessage 的净化不可信）：
  // 中和用户消息里伪造/闭合 <clickin-…> 包裹块的企图，保留合法 ui-context 信封。
  const message = neutralizeInboundMessage(rawMessage);
  if (!sessionKey || typeof sessionKey !== "string") {
    return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  }
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  // 项目档位功能门（#280）：签发时已拦（sessions POST），这里对存量已签发的
  // production 会话兜底——降级后旧 sessionKey 不能继续产生 AI 消耗。
  const prodId = productionIdOfSessionKey(sessionKey);
  if (prodId) {
    const planDeny = await requireProductionFeature(prodId, "ai");
    if (planDeny) return planDeny;
  }

  if (await shouldUseRunner(sessionKey)) {
    if (steer === true) {
      try {
        const steered = await steerRun(sessionKey, message);
        if (!steered) return NextResponse.json({ error: "本轮回复已结束，请重新发送" }, { status: 409 });
        return NextResponse.json({ ok: true, runId: steered.runId });
      } catch (err) {
        return toErrorResponse(err);
      }
    }
    return createRunnerStreamResponse(req, sessionKey, {
      startRun: () => startRun({ sessionId: sessionKey, userId: auth.userId, message, pageKey: pageKeyOfMessage(message) }),
    });
  }

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

  if (await shouldUseRunner(sessionKey)) {
    return createRunnerStreamResponse(req, sessionKey);
  }

  // Shorter quiet window than a fresh send: attach 上来 20s 没动静，多半是
  // run 在 attach 落地前就已结束——尽快触发一次权威状态查询：确实结束就走
  // chat.history 收尾；还在跑（长工具调用静默期）则继续等，不会误杀。
  return createChatStreamResponse(req, sessionKey, { quietTimeoutMs: 20_000 });
}
