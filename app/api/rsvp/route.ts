import { type NextRequest, NextResponse } from "next/server";
import { verifyRsvpToken } from "@/lib/platform/email/email-tokens";
import { rsvpCallTime } from "@/lib/inbox-db";
import { getPool } from "@/lib/pg";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return htmlReply("链接无效。", false);

  const data = verifyRsvpToken(token);
  if (!data) return htmlReply("此链接已过期，请在应用内操作。", false);

  const pool = getPool();
  try {
    if (data.action === "confirm") {
      await pool.query(
        `UPDATE event_call_time SET confirmed_at = now() WHERE id = $1 AND user_id = $2`,
        [data.callTimeId, data.userId],
      );
    } else {
      await rsvpCallTime(data.callTimeId, data.userId, data.action);
    }
    await pool.query(
      `UPDATE user_notification
       SET acted_at = now(), read_at = COALESCE(read_at, now()),
           action_result = jsonb_build_object('rsvp', $1::text)
       WHERE entity_type = 'call_time' AND entity_id = $2
         AND user_id = $3 AND acted_at IS NULL`,
      [data.action, data.callTimeId, data.userId],
    );
  } catch {
    return htmlReply("出现错误，请在应用内操作。", false);
  }

  return htmlReply("回复已记录，感谢你的确认。", true);
}

function htmlReply(message: string, ok: boolean): NextResponse {
  const color = ok ? "#2f6670" : "#c53030";
  const icon  = ok ? "✓" : "✕";
  const html = `<!DOCTYPE html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? "已确认" : "操作失败"}</title>
<style>
  body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100dvh;
    background:#f4f5f3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .card{background:#fff;border:1px solid #dde3e1;border-radius:14px;padding:40px 36px;
    max-width:360px;width:90%;text-align:center}
  .icon{font-size:40px;color:${color};margin-bottom:12px}
  h1{margin:0 0 8px;font-size:18px;font-weight:700;color:#182a2a}
  p{margin:0;font-size:13px;color:#667676;line-height:1.6}
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${ok ? "已确认" : "操作失败"}</h1>
  <p>${message}</p>
</div>
</body></html>`;
  return new NextResponse(html, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
