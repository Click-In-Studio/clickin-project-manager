import { type NextRequest, NextResponse } from "next/server";
import { getPendingApprovalSession, resolveApproval, startChatRun } from "@/lib/agent-gateway/client";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";

export const runtime = "nodejs";

const DECISIONS = new Set(["allow-once", "allow-always", "deny"]);

// Resolves a pending plugin approval (write-tool confirmation gate). The
// /agent page is the team gateway's only approval surface — dashboard is
// disabled — so this endpoint is what actually unblocks gated MCP writes.
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
    return NextResponse.json({ error: "decision 必须是 allow-once/allow-always/deny" }, { status: 400 });
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    return NextResponse.json({ error: "reason 必须是 500 字符以内的字符串" }, { status: 400 });
  }

  // Ownership: an approval belongs to the session that triggered it — only
  // that session's owner may resolve it. Unknown id (expired, already
  // resolved, or never routed here) gets the same 403 as a foreign session,
  // so approval-id existence is never revealed.
  const sessionKey = getPendingApprovalSession(id);
  if (!sessionKey) {
    return NextResponse.json({ error: "无权处理该确认请求" }, { status: 403 });
  }
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;

  try {
    await resolveApproval(id, decision as "allow-once" | "allow-always" | "deny");
    // 拒绝理由通过 queue-steer 注入还在等待的 run：gateway 的 resolve RPC
    // 不携带理由，但 run 此刻正阻塞在被拒的工具结果上，注入的消息会在下一
    // 个模型边界与"工具被拒"一起呈现给 agent，它能据此调整方案。
    // best-effort：注入失败不影响 resolve 本身的成功返回。
    if (decision === "deny" && typeof reason === "string" && reason.trim()) {
      startChatRun(sessionKey, `【审批拒绝理由】${reason.trim()}`).catch((err) => {
        console.warn("[agent-approval] 拒绝理由注入失败（resolve 已成功）:", err instanceof Error ? err.message : err);
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
