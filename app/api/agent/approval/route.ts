import { type NextRequest, NextResponse } from "next/server";
import { getPendingApprovalSession, resolveApproval, storeDenyReason } from "@/lib/agent-gateway/client";
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
    // 拒绝理由在 resolve **之前**暂存（键为 toolCallId）：gateway 的 resolve
    // 协议不携带理由，插件在 tool_result_persist 里经 MCP 同进程端点取走并
    // 重写进被拒工具结果——与拒绝同帧到达模型，单次回复（steer 注入会造成
    // "先答默认拒绝、再答理由"的双回复）。先存后 resolve 保证时序。
    if (decision === "deny" && typeof reason === "string" && reason.trim()) {
      const stored = storeDenyReason(id, reason.trim());
      if (!stored) console.warn(`[agent-approval] approval ${id} 无 toolCallId 关联，拒绝理由无法转交插件`);
    }
    await resolveApproval(id, decision as "allow-once" | "allow-always" | "deny");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
