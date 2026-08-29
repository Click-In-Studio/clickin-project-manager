import { type NextRequest, NextResponse } from "next/server";
import { sessionKeyOwnedBy } from "@/lib/agent-tools/session-identity";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-chat/http";
import { listPendingQuestions, questionSession, resolveQuestion } from "@/lib/agent-runtime/questions";

export const runtime = "nodejs";

// ask_user 问题卡片的恢复与回答面。GET 用于重开会话时恢复待答卡片——卡片看不见就
// 等于 agent 在隐形卡死；POST 把回答/取消送回，解除 agent 阻塞的 run。
// 问题 id 以 aq_ 开头、在 agent_question 表里（前缀契约有测试钉住）。

export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  const sessionKey = req.nextUrl.searchParams.get("sessionKey");
  if (!sessionKey) {
    return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  }
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  try {
    const questions = await listPendingQuestions(sessionKey);
    return NextResponse.json({ questions });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  let body: { id?: unknown; answers?: unknown; cancel?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, answers, cancel } = body;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }
  const isCancel = cancel === true;
  if (!isCancel && (typeof answers !== "object" || answers === null || Array.isArray(answers))) {
    return NextResponse.json({ error: "缺少 answers" }, { status: 400 });
  }
  // 协议要求即使单选也是数组；这里顺带把非数组值规整掉，防前端手滑。
  const normalized: Record<string, string[]> = {};
  if (!isCancel) {
    for (const [qid, v] of Object.entries(answers as Record<string, unknown>)) {
      if (typeof qid !== "string" || !qid) continue;
      const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x.length > 0);
      if (list.length > 0) normalized[qid] = list;
    }
    if (Object.keys(normalized).length === 0) {
      return NextResponse.json({ error: "answers 为空" }, { status: 400 });
    }
  }

  try {
    // 所有权：问题归属其 sessionKey，回答人必须是该会话的主人。归属查不到
    // （已过期/已回答/伪造 id）和归属他人的会话**统一按 404 收**——403/404
    // 分叉会让调用方用状态码探测某个 question id 是否存在，与 http.ts
    // requireOwnership 的"不泄露存在性"约定相悖。
    const sessionKey = await questionSession(id);
    if (!sessionKey || !sessionKeyOwnedBy(sessionKey, auth.userId)) {
      return NextResponse.json({ error: "问题不存在或已过期" }, { status: 404 });
    }
    const ok = await resolveQuestion(id, isCancel ? { cancel: true } : { answers: normalized });
    if (!ok) return NextResponse.json({ error: "问题不存在或已过期" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
