import { type NextRequest, NextResponse } from "next/server";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-chat/http";
import { approvalSession, resolveApproval } from "@/lib/agent-runtime/approvals";

export const runtime = "nodejs";

const DECISIONS = new Set(["allow-once", "deny"]);

// Resolves a pending approval (write-tool confirmation gate). The /agent
// popout is the only approval surface — dashboard is disabled — so this
// endpoint is what actually unblocks gated writes.
//
// 审批 id 以 ap_ 开头、在 agent_approval 表里（前缀契约有测试钉住）。
export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  let body: { id?: unknown; decision?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, decision, reason } = body;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }
  if (typeof decision !== "string" || !DECISIONS.has(decision)) {
    return NextResponse.json({ error: "decision 必须是 allow-once/deny" }, { status: 400 });
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    return NextResponse.json({ error: "reason 必须是 500 字符以内的字符串" }, { status: 400 });
  }
  const trimmedReason = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;

  // 所有权：审批归属触发它的会话，只有会话主人能决议。查不到（过期/已决议/伪造 id）
  // 与归属他人统一 403，不泄露 id 是否存在。
  const sessionKey = await approvalSession(id);
  if (!sessionKey) return NextResponse.json({ error: "无权处理该确认请求" }, { status: 403 });
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;
  try {
    // 理由与决议同一行落库；run 侧 awaitApproval 读到后把理由随工具结果回模型
    const ok = await resolveApproval(id, decision as "allow-once" | "deny", auth.userId, trimmedReason);
    if (!ok) return NextResponse.json({ error: "无权处理该确认请求" }, { status: 403 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
