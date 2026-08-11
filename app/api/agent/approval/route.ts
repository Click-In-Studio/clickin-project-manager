import { type NextRequest, NextResponse } from "next/server";
import { getPendingApprovalSession, resolveApproval } from "@/lib/agent-gateway/client";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent-gateway/http";

export const runtime = "nodejs";

const DECISIONS = new Set(["allow-once", "allow-always", "deny"]);

// Resolves a pending plugin approval (write-tool confirmation gate). The
// /agent page is the team gateway's only approval surface — dashboard is
// disabled — so this endpoint is what actually unblocks gated MCP writes.
export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  let body: { id?: unknown; decision?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, decision } = body;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }
  if (typeof decision !== "string" || !DECISIONS.has(decision)) {
    return NextResponse.json({ error: "decision 必须是 allow-once/allow-always/deny" }, { status: 400 });
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
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
