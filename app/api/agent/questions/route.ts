import { type NextRequest, NextResponse } from "next/server";
import { sessionKeyOwnedBy } from "@/lib/agent/tools/session-identity-parse";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent/chat/http";
import { listQuestions, questionSession, resolveQuestionDetailed } from "@/lib/agent/runtime/questions";
import { EventPublisher } from "@/lib/agent/runtime/events";
import { wakeSession } from "@/lib/agent/runtime/client";

export const runtime = "nodejs";

// ask_user 问题卡片的恢复与回答面。GET 恢复历史及待答卡片，前端按 toolCallId 放回
// 原对话位置；POST 对 required 解除原 run，对 continue_independent 原子写入迟到回答 inbox。
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
    const questions = await listQuestions(sessionKey);
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
    const question = await resolveQuestionDetailed(id, isCancel ? { cancel: true } : { answers: normalized });
    if (!question) return NextResponse.json({ error: "问题不存在或已过期" }, { status: 404 });
    if (question.waitMode === "continue_independent") {
      const publisher = new EventPublisher(sessionKey,null);
      publisher.publish({ type: "question-resolved",id,status: question.status,question });
      await publisher.drain();
      // 回答已随问题决议原子落进 inbox；唤醒失败也不会丢，runner 巡检会补消费。
      await wakeSession(sessionKey).catch(() => {});
    }
    return NextResponse.json({ ok: true, question });
  } catch (err) {
    return toErrorResponse(err);
  }
}
