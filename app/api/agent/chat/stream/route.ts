import { type NextRequest, NextResponse } from "next/server";
import { productionIdOfSessionKey } from "@/lib/agent-tools/session-identity";
import { requireProductionFeature } from "@/lib/plan";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-chat/http";
import { neutralizeInboundMessage } from "@/lib/agent-ui-context";
import { createRunnerStreamResponse, pageKeyOfMessage } from "@/lib/agent-runtime/dispatch";
import { startRun, steerRun } from "@/lib/agent-runtime/client";

export const runtime = "nodejs";

// Sends a new message and streams the reply — newline-delimited JSON via
// plain fetch + ReadableStream rather than EventSource, since EventSource
// can't send a POST body. Each line is one
// { type: "delta" | "final" | "tool" | "tool-end" | "aborted" | "error", ... } event.
//
// 自建运行时（#367）：run 由 agent-runner 执行，本路由从 agent_event 直出 SSE。
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

  // steer：会话已有 run 在跑，把这条消息插进去。回复走已经打开的那条流，所以这里
  // 返回纯 JSON 而不是第二条流——每次 steer 多开一条没人读的流会把浏览器的同域
  // 连接池耗光、整页静默（网关时代线上调过的教训）。
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

  return createRunnerStreamResponse(req, sessionKey);
}
