import { type NextRequest, NextResponse } from "next/server";
import { verifyRsvpToken } from "@/lib/auth-email";
import { rsvpCallTime } from "@/lib/inbox-db";
import { getPool } from "@/lib/pg";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return redirect(req, "invalid");

  const data = verifyRsvpToken(token);
  if (!data) return redirect(req, "expired");

  try {
    if (data.action === "confirm") {
      await getPool().query(
        `UPDATE event_call_time SET confirmed_at = now() WHERE id = $1 AND user_id = $2`,
        [data.callTimeId, data.userId],
      );
    } else {
      await rsvpCallTime(data.callTimeId, data.userId, data.action);
    }
  } catch {
    return redirect(req, "error");
  }

  return redirect(req, "ok");
}

function redirect(req: NextRequest, status: "ok" | "invalid" | "expired" | "error"): NextResponse {
  const messages: Record<string, string> = {
    ok:      "回复已记录，感谢你的确认。",
    invalid: "链接无效。",
    expired: "此链接已过期，请在应用内操作。",
    error:   "出现错误，请在应用内操作。",
  };
  const msg = encodeURIComponent(messages[status]);
  return NextResponse.redirect(new URL(`/?rsvp_msg=${msg}`, req.url));
}
