import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyBindingToken, signConflictToken } from "@/lib/platform/email/email-tokens";
import { bindPlatformIdentity, getUserProfile } from "@/lib/db";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/session";

function redirectBase(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

function confirmPage(token: string, email: string): NextResponse {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>确认绑定邮箱</title>
<style>
  body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f3f4f3}
  .card{background:#fff;border-radius:12px;padding:32px;max-width:400px;width:90%;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  h2{margin:0 0 8px;font-size:18px;color:#182a2a}
  p{margin:0 0 24px;color:#667676;font-size:14px;line-height:1.5}
  .email{font-weight:700;color:#182a2a}
  button{width:100%;padding:12px;font-size:15px;font-weight:700;background:#182a2a;color:#fff;border:none;border-radius:8px;cursor:pointer}
  button:hover{background:#2a3f3f}
  a{display:block;text-align:center;margin-top:12px;font-size:13px;color:#999;text-decoration:none}
</style>
</head><body>
<div class="card">
  <h2>确认绑定邮箱</h2>
  <p>将 <span class="email">${email}</span> 绑定到你的后台账号。</p>
  <form method="POST">
    <input type="hidden" name="token" value="${token}">
    <button type="submit">确认绑定</button>
  </form>
  <a href="/account">取消</a>
</div>
</body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// GET — verify token and render confirmation page (no mutation, safe for mail scanners)
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const base = redirectBase(req);

  if (!token) return NextResponse.redirect(new URL("/account?bind_error=invalid", base));

  const data = verifyBindingToken(token);
  if (!data) return NextResponse.redirect(new URL("/account?bind_error=expired", base));

  return confirmPage(token, data.email);
}

// POST — user clicked confirm; perform the actual binding
export async function POST(req: NextRequest) {
  const base = redirectBase(req);
  const form = await req.formData();
  const token = form.get("token");

  if (typeof token !== "string") return NextResponse.redirect(new URL("/account?bind_error=invalid", base));

  const data = verifyBindingToken(token);
  if (!data) return NextResponse.redirect(new URL("/account?bind_error=expired", base));

  const { sourceUserId, email } = data;
  const bindResult = await bindPlatformIdentity(sourceUserId, "email", email);

  const profile = await getUserProfile(sourceUserId);
  const sessionId = createSession({
    userId: sourceUserId,
    name: profile?.name ?? email,
    avatarUrl: profile?.avatarUrl ?? null,
    isAdmin: profile?.isAdmin ?? false,
  });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);

  if (bindResult.result === "conflict") {
    const mergeToken = signConflictToken(sourceUserId, bindResult.existingUserId);
    const url = new URL("/account", base);
    url.searchParams.set("pending_merge", mergeToken);
    url.searchParams.set("merge_platform", "email");
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL("/account?bound=email", base));
}
