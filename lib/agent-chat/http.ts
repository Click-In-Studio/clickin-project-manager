import { NextResponse } from "next/server";
import type { SessionData } from "@/lib/session";
import { getSession } from "@/lib/session";
import { sessionKeyOwnedBy } from "@/lib/agent-tools/session-identity";

/** 抛出的错误 → JSON 响应，尊重错误对象上的 `status`（409 会话忙、403 无权 …）。 */
export function toErrorResponse(err: unknown): NextResponse {
  const status = (err as { status?: number })?.status ?? 500;
  const message = err instanceof Error ? err.message : "Internal error";
  return NextResponse.json({ error: message }, { status });
}

type CookieSource = { get: (name: string) => { value: string } | undefined };

/** Auth guard: returns the session, or a ready-to-return 401 response. */
export function requireUser(cookies: CookieSource): SessionData | NextResponse {
  const session = getSession(cookies);
  if (!session) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return session;
}

/** Ownership guard for a session key the client supplied. Returns null when
 * the key belongs to the user, or a ready-to-return 403 response. 404 is
 * deliberately NOT used — key existence is never revealed either way. */
export function requireOwnership(sessionKey: string, userId: string): NextResponse | null {
  if (sessionKeyOwnedBy(sessionKey, userId)) return null;
  return NextResponse.json({ error: "无权访问该会话" }, { status: 403 });
}
